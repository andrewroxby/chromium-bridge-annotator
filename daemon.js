// chromium-bridge daemon: the resident process behind bin/chromium-bridge.
//
// It holds a browser-level CDP connection to each host browser and attaches
// a PageController (page.js) to every page tab. Through those sessions it
// reloads and navigates tabs, and carries window.chromiumBridge.send(data)
// from pages into an in-memory event queue. It also watches folders for
// changes and serves local files over http.
//
// Two kinds of host. A pane host is a terminal-browser instance, drawn
// inside a tmux pane; the daemon finds them through `terminal-browser ls`
// and never starts one itself, since that needs the caller's tty. The
// window host is Chromium on a dedicated profile, which the daemon launches
// on demand. The daemon lives while any host does and exits a minute after
// the last one goes.
//
// Start modes:
//   node daemon.js --idle-ok  start even with no host running, and wait for one
//   node daemon.js            attach only; exit 3 when no host is running
//
// The CLI speaks HTTP over a unix socket in the state folder. The socket is
// mode 0600, so its file permissions are the only auth. Every route takes
// window=SESSION:@ID, the caller's tmux window, which scopes "the active
// tab" to the pane host there. Routes:
//   status            hosts and tab count
//   open?url=         open a page; reuses a tab already showing it unless
//     &host=            new=1. host=pane (default) or window. watch=DIR
//     &new=1            reloads the tab whenever a file under DIR changes.
//     &watch=DIR        owner=JSON registers the caller's pane as the tab's
//     &owner=JSON       doorbell owner. With no pane host in the window,
//                       answers {launch: true, url} for the CLI to start one
//   tabs              open page tabs, each with its registered owner
//   reload?id=        reload a tab (default: the active one)
//   close?id=         close a tab
//   events?wait=&tab=&peek=1
//                     take what pages sent; wait=N long-polls up to N seconds
//   cdp-url?id=       per-tab CDP WebSocket URL and target id (default: the
//                     active tab)
//   comments?id=      a tab's annotate-mode comments (default: the active tab)
//   resolve?id=&comment=   POST {reply}; answers one comment on a tab
//   notify?id=        POST an owner {kind, pane, socket, bin?} to register
//                     for doorbell notices on a tab (default: the active
//                     one), or {off: true} to stop ringing for it
//   doctor            prove CDP and the channel on the pane host in the
//                     window, or on a background Chromium tab

const http = require("node:http");
const net = require("node:net");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { PageController } = require("./page");

const execFileAsync = promisify(execFile);

const STATE_DIR = path.join(
  process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"),
  "chromium-bridge",
);
const PROFILE_DIR = path.join(STATE_DIR, "profile");
const PORT_FILE = path.join(PROFILE_DIR, "DevToolsActivePort");
const SOCKET = path.join(STATE_DIR, "daemon.sock");
const LOCK_FILE = path.join(STATE_DIR, "daemon.lock");

const CHROMIUM_APP = "/Applications/Chromium.app";

// --use-mock-keychain keeps the bridge profile off the login keychain. The
// real "Chromium Safe Storage" item belongs to the user's own Chromium, and
// waiting on it (a locked keychain, a prompt) stalls every network load.
const CHROMIUM_FLAGS = [
  `--user-data-dir=${PROFILE_DIR}`,
  "--remote-debugging-port=0",
  "--no-first-run",
  "--no-default-browser-check",
  "--no-startup-window",
  "--use-mock-keychain",
];

const EXIT_NO_BROWSER = 3;
const IDLE_EXIT_MS = 60000;
const PANE_SCAN_TIMEOUT_MS = 5000;
const CONTROL_TIMEOUT_MS = 5000;

// A host: one browser the daemon is attached to.
//   { id, kind: "window" | "pane", cdp, port, ws, product, pid,
//     key?, socket?, pane?, window?, tty? }   (pane hosts, from terminal-browser ls)
const hosts = new Map();
let idleTimer;
let server;
let fileServer;
let ownsLock = false;
let shuttingDown = false;
const startedAt = new Date().toISOString();

const served = new Map(); // key -> directory
const servedKeys = new Map(); // directory -> key

const tabs = new Map(); // targetId -> { targetId, id, host, url, title, controller, hidden, onEvent, paneTab?, paneActive? }
let nextTabId = 1; // tab ids (t1, t2, ...) follow discovery order and last the tab's life
let lastTouched; // targetId of the tab the bridge last opened or reloaded

const watchers = new Map(); // targetId -> { watcher, dir, timer }

const MAX_EVENTS = 1000;
const MAX_WAIT_SECONDS = 600;
let events = [];
let nextSeq = 1;
const waiters = new Set();

const RING_DELAY_MS = 500; // coalescing window: bursts within it ring once
const HERDR_TIMEOUT_MS = 10000;
const HERDR_WAIT_TIMEOUT_MS = 600000; // matches herdr's own wait cap
const TMUX_TIMEOUT_MS = 5000;
const DRAFT_POLL_MS = 3000;
const DRAFT_HOLD_MAX_MS = 10 * 60 * 1000; // past this, an abandoned draft no longer blocks the doorbell
const TMUX_SHELLS = new Set(["zsh", "bash", "sh", "fish", "-zsh", "-bash", "-sh", "-fish"]);

const tabOwners = new Map(); // tab id -> { kind, pane, socket, bin? }, or null when ringing is off
let lastOwner; // most recently registered owner, fallback for a tab nobody opened
const ringTimers = new Map(); // tab id -> pending coalescing timer
const lastRung = new Map(); // tab id -> highest event seq already rung for

function log(...args) {
  console.error(new Date().toISOString(), ...args);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- CDP connection ----------------------------------------------------------

// One WebSocket to the browser target. Flattened sessions share it: a message
// with a sessionId belongs to that tab's PageController, and one without
// belongs to the browser.
class Cdp {
  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => resolve(new Cdp(ws)), { once: true });
      ws.addEventListener("error", () => reject(new Error(`could not connect to ${url}`)), { once: true });
    });
  }

  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map(); // id -> { resolve, reject, timer, method }
    this.sessions = new Map(); // sessionId -> handler(msg)
    this.onEvent = () => {};
    this.onClose = () => {};
    ws.addEventListener("message", (e) => this.receive(JSON.parse(e.data)));
    ws.addEventListener("close", () => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error("browser connection closed"));
      }
      this.pending.clear();
      this.onClose();
    });
  }

  receive(msg) {
    if (msg.id !== undefined) {
      const call = this.pending.get(msg.id);
      if (!call) return;
      this.pending.delete(msg.id);
      clearTimeout(call.timer);
      if (msg.error) call.reject(new Error(`${call.method}: ${msg.error.message}`));
      else call.resolve(msg.result || {});
      return;
    }
    if (msg.sessionId) {
      const handler = this.sessions.get(msg.sessionId);
      if (handler) handler(msg);
      return;
    }
    this.onEvent(msg);
  }

  send(method, params = {}, sessionId, timeoutMs = 30000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      this.ws.send(JSON.stringify(msg));
    });
  }
}

// --- Hosts -------------------------------------------------------------------

function windowHost() {
  return hosts.get("window");
}

function paneHosts() {
  return [...hosts.values()].filter((h) => h.kind === "pane");
}

// terminal-browser names a pane's tmux window "session:@id", which is what
// the CLI sends as window=.
function paneHostsIn(window) {
  return window ? paneHosts().filter((h) => h.window === window) : paneHosts();
}

async function attachHost(host) {
  host.cdp = await Cdp.connect(host.ws);
  host.cdp.onEvent = (msg) => onBrowserEvent(host, msg);
  host.cdp.onClose = () => dropHost(host, "browser closed");
  hosts.set(host.id, host);
  clearTimeout(idleTimer);
  await host.cdp.send("Target.setDiscoverTargets", { discover: true });
  log(`attached ${host.id}: ${host.product} on port ${host.port}`);
  return host;
}

function dropHost(host, reason) {
  if (hosts.get(host.id) !== host) return;
  hosts.delete(host.id);
  for (const tab of [...tabs.values()]) if (tab.host === host) forgetTab(tab.targetId);
  log(`dropped ${host.id}: ${reason}`);
  if (hosts.size === 0) armIdleExit();
}

function armIdleExit() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (hosts.size === 0) shutdown("no browser for 60s");
  }, IDLE_EXIT_MS);
}

// --- Window host: Chromium ----------------------------------------------------

async function attachChromium(launch) {
  if (windowHost()) return windowHost();
  let found = await findBrowser();
  if (!found) {
    if (!launch) return undefined;
    found = await launchBrowser();
  }
  return attachHost({ id: "window", kind: "window", ...found, pid: findBrowserPid() });
}

// The profile's live browser, or null. Chromium writes its debug port and
// browser path to DevToolsActivePort; a file left by a dead browser, or a
// port since taken by another browser, fails the check against /json/version.
async function findBrowser() {
  let port, wsPath;
  try {
    [port, wsPath] = fs.readFileSync(PORT_FILE, "utf8").split("\n");
  } catch {
    return null;
  }
  try {
    const res = await fetch(`http://127.0.0.1:${Number(port)}/json/version`, {
      signal: AbortSignal.timeout(2000),
    });
    const info = await res.json();
    if (!info.webSocketDebuggerUrl.endsWith(wsPath.trim())) return null;
    return { port: Number(port), ws: info.webSocketDebuggerUrl, product: info.Browser };
  } catch {
    return null;
  }
}

// The bridge's own Chromium process: the one whose command line names this
// profile and isn't a --type= helper (GPU, renderer, utility, ...). The
// user's own Chromium shares the app and bundle id, so matching by profile
// path is what tells the two apart.
function findBrowserPid() {
  let out;
  try {
    out = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  } catch {
    return null;
  }
  for (const line of out.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!match) continue;
    const [, pid, command] = match;
    if (command.includes(`--user-data-dir=${PROFILE_DIR}`) && !command.includes("--type=")) {
      return Number(pid);
    }
  }
  return null;
}

// Start Chromium on the bridge profile without taking focus. -n starts a new
// instance even when the user's own Chromium is running. Chromium activates
// itself when it opens a startup window, so it starts with none; newTab
// opens a window without activating it.
async function launchBrowser() {
  fs.mkdirSync(PROFILE_DIR, { recursive: true, mode: 0o700 });
  fs.rmSync(PORT_FILE, { force: true });
  log("launching Chromium");
  execFileSync("open", ["-g", "-n", "-a", CHROMIUM_APP, "--args", ...CHROMIUM_FLAGS]);
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await sleep(200);
    const found = await findBrowser();
    if (found) return found;
  }
  throw new Error("Chromium never opened its debug port; is the bridge profile open in another Chromium?");
}

// --- Pane hosts: terminal-browser --------------------------------------------
//
// terminal-browser keeps its own registry of running instances, read through
// `terminal-browser ls`. Each instance exposes a CDP port, used here for the
// channel, reload, and navigate, and a control socket for the tab operations
// its Electron does not take over CDP: Target.createTarget answers "Not
// supported" and Target.activateTarget is a no-op there. Starting an instance
// needs the caller's tty, so the CLI does that; the daemon only attaches.

function terminalBrowserBinary() {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    const candidate = path.join(dir, "terminal-browser");
    if (dir && fs.existsSync(candidate)) return candidate;
  }
  return "/opt/homebrew/bin/terminal-browser";
}

async function listPanes() {
  try {
    const { stdout } = await execFileAsync(terminalBrowserBinary(), ["ls", "--all", "--json"], {
      timeout: PANE_SCAN_TIMEOUT_MS,
    });
    return JSON.parse(stdout).browsers || [];
  } catch (err) {
    if (err.code !== "ENOENT") log("terminal-browser ls failed:", err.message);
    return [];
  }
}

// Attach to every terminal-browser not yet attached. One scan at a time, so
// two commands arriving together don't attach the same instance twice.
let paneScan;
function scanPanes() {
  if (!paneScan) {
    paneScan = (async () => {
      const seen = await listPanes();
      await Promise.all(
        seen.map(async (entry) => {
          const id = `pane:${entry.key}`;
          if (!entry.cdpPort || hosts.has(id)) return;
          let info;
          try {
            const res = await fetch(`http://127.0.0.1:${entry.cdpPort}/json/version`, { signal: AbortSignal.timeout(2000) });
            info = await res.json();
          } catch {
            return;
          }
          await attachHost({
            id,
            kind: "pane",
            key: entry.key,
            port: entry.cdpPort,
            ws: info.webSocketDebuggerUrl,
            product: info.Browser,
            pid: entry.pid,
            socket: entry.socket,
            pane: entry.pane && entry.pane.pane,
            window: entry.pane && entry.pane.tab,
            tty: entry.tty,
          }).catch((err) => log(`attach ${id} failed:`, err.message));
        }),
      );
    })().finally(() => {
      paneScan = undefined;
    });
  }
  return paneScan;
}

// One request on an instance's control socket: a JSON line with an id in,
// a JSON line back, then the browser closes the connection.
function control(host, msg, timeoutMs = CONTROL_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomBytes(4).toString("hex");
    const conn = net.connect(host.socket);
    let buffer = "";
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error(`terminal-browser ${msg.cmd} timed out`));
    }, timeoutMs);
    conn.once("connect", () => conn.write(`${JSON.stringify({ id, ...msg })}\n`));
    conn.on("data", (chunk) => (buffer += chunk));
    conn.once("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`terminal-browser ${msg.cmd}: ${err.message}`));
    });
    conn.once("close", () => {
      clearTimeout(timer);
      let reply;
      try {
        reply = JSON.parse(buffer.split("\n").find((line) => line.trim()) || "");
      } catch {
        return reject(new Error(`terminal-browser ${msg.cmd}: no reply`));
      }
      if (reply.ok) resolve(reply.data);
      else reject(new Error(`terminal-browser ${msg.cmd}: ${reply.error}`));
    });
  });
}

// terminal-browser's own view of a pane host's tabs: its tab ids, needed to
// select or close one, and which tab is selected. Also the surest way to
// learn of a tab the CDP target events haven't reported yet.
async function syncPaneTabs(host) {
  const { tabs: list = [] } = await control(host, { cmd: "targets" });
  for (const entry of list) {
    if (!entry.targetId) continue;
    const tab = trackTarget(host, { targetId: entry.targetId, type: "page", url: entry.url, title: entry.title });
    if (!tab) continue;
    tab.paneTab = entry.id;
    tab.paneActive = Boolean(entry.active);
  }
  return list;
}

// --- Tabs --------------------------------------------------------------------

function isPage(info) {
  return info.type === "page" && !info.url.startsWith("devtools://") && info.subtype !== "prerender";
}

function onBrowserEvent(host, msg) {
  const params = msg.params;
  if (msg.method === "Target.targetCreated" || msg.method === "Target.targetInfoChanged") {
    trackTarget(host, params.targetInfo);
  } else if (msg.method === "Target.targetDestroyed") {
    forgetTab(params.targetId);
  } else if (msg.method === "Target.detachedFromTarget") {
    for (const tab of tabs.values()) {
      if (tab.controller && tab.controller.sessionId === params.sessionId) {
        tab.controller.dispose();
        tab.controller = undefined;
      }
    }
  }
}

// Every page target gets a record and a PageController. That covers tabs the
// bridge opens, tabs the user opens, and tabs other CDP clients open.
function trackTarget(host, info) {
  if (!isPage(info)) return undefined;
  let tab = tabs.get(info.targetId);
  if (!tab) {
    tab = { targetId: info.targetId, id: `t${nextTabId++}`, host };
    tabs.set(info.targetId, tab);
  }
  tab.url = info.url;
  tab.title = info.title;
  controllerFor(tab);
  return tab;
}

// Chromium reports a title change only with the next navigation, so listings
// read current titles and urls first.
async function refreshTargets() {
  for (const host of hosts.values()) {
    const { targetInfos } = await host.cdp.send("Target.getTargets").catch(() => ({ targetInfos: [] }));
    for (const info of targetInfos) {
      const tab = tabs.get(info.targetId);
      if (tab) Object.assign(tab, { url: info.url, title: info.title });
    }
  }
}

function forgetTab(targetId) {
  const tab = tabs.get(targetId);
  if (!tab) return;
  stopWatch(targetId);
  if (tab.controller) tab.controller.dispose();
  tabs.delete(targetId);
  if (lastTouched === targetId) lastTouched = undefined;
  tabOwners.delete(tab.id);
  clearRing(tab.id);
}

function controllerFor(tab) {
  if (!tab.controller) {
    const controller = new PageController(tab.host.cdp, tab.targetId, (data) => onPageEvent(tab, data));

    // A failed attach is retried on next use. Callers that await `ready`
    // still see the failure.
    controller.ready.catch((err) => {
      log(`attach to ${tab.targetId} failed:`, err.message);
      if (tab.controller === controller) tab.controller = undefined;
    });
    tab.controller = controller;
  }
  return tab.controller;
}

function publicTabs() {
  return [...tabs.values()].filter((t) => !t.hidden);
}

function findTab(id) {
  return publicTabs().find((t) => t.id === id);
}

function hostLabel(host) {
  return host.kind === "window" ? "window" : host.pane || host.id;
}

function describeTab(tab, active) {
  const watching = watchers.get(tab.targetId);
  return {
    id: tab.id,
    targetId: tab.targetId,
    host: hostLabel(tab.host),
    url: tab.url,
    title: tab.title,
    active: tab === active,
    watching: watching ? watching.dir : null,
    file: sourceFile(tab.url),
    owner: tabOwners.get(tab.id) || null,
  };
}

// The tab a command means when it names none. Pane hosts in the caller's
// tmux window come first, then the Chromium window, then any pane host.
// Within each tier the last-touched tab wins ties.
async function activeTab(window) {
  const tiers = window
    ? [paneHostsIn(window), [windowHost()], paneHosts()]
    : [paneHosts(), [windowHost()]];
  for (const tier of tiers) {
    const members = tier.filter(Boolean);
    if (!members.length) continue;
    const tab = members[0].kind === "pane" ? await activePaneTab(members) : await activeWindowTab();
    if (tab) return tab;
  }
  return undefined;
}

const prefer = (list) => list.find((t) => t.targetId === lastTouched) || list[list.length - 1];

// terminal-browser knows which of its tabs is selected.
async function activePaneTab(members) {
  await Promise.all(members.map((h) => syncPaneTabs(h).catch(() => {})));
  const candidates = publicTabs().filter((t) => members.includes(t.host));
  return prefer(candidates.filter((t) => t.paneActive)) || prefer(candidates);
}

// CDP has no "selected tab" event, so ask each tab. A window's selected tab
// is visible and the rest are hidden; the focused one also has focus. Prefer
// focused, then visible, then the tab the bridge last touched, then the
// newest.
async function activeWindowTab() {
  const candidates = publicTabs().filter((t) => t.host.kind === "window");
  if (!candidates.length) return undefined;
  const states = await Promise.all(candidates.map(pageState));
  return (
    prefer(candidates.filter((_, i) => states[i].focused)) ||
    prefer(candidates.filter((_, i) => states[i].visible)) ||
    prefer(candidates)
  );
}

async function pageState(tab) {
  const unknown = { visible: false, focused: false };
  try {
    const probe = controllerFor(tab).command("Runtime.evaluate", {
      expression: `({ visible: document.visibilityState === "visible", focused: document.hasFocus() })`,
      returnByValue: true,
    });
    const timeout = sleep(1000).then(() => ({}));
    const { result } = await Promise.race([probe, timeout]);
    return (result && result.value) || unknown;
  } catch {
    return unknown;
  }
}

async function tabOrActive(id, window) {
  const tab = id ? findTab(id) : await activeTab(window);
  if (!tab) throw httpError(404, id ? `no tab ${id}` : "no browser tabs");
  return tab;
}

// A blank tab on the host, ready to navigate once its controller attaches.
// In Chromium that is a background tab in the last active window; with no
// page open there may be no window at all, and createTarget then needs
// newWindow to make one. In terminal-browser the control socket opens it,
// and its CDP target can take a moment to appear.
async function newTab(host) {
  if (host.kind === "window") {
    const { targetId } = await host.cdp.send("Target.createTarget", {
      url: "about:blank",
      background: true,
      newWindow: !publicTabs().some((t) => t.host === host),
    });
    return trackTarget(host, { targetId, type: "page", url: "about:blank", title: "" });
  }
  const { openedTab } = await control(host, { cmd: "open-tab", url: "about:blank" });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const list = await syncPaneTabs(host);
    const entry = list.find((e) => e.id === openedTab && e.targetId);
    if (entry) return tabs.get(entry.targetId);
    await sleep(100);
  }
  throw httpError(500, `terminal-browser never reported tab ${openedTab}`);
}

async function selectTab(tab) {
  if (tab.host.kind === "window") {
    await tab.host.cdp.send("Target.activateTarget", { targetId: tab.targetId }).catch(() => {});
  } else if (tab.paneTab !== undefined) {
    await control(tab.host, { cmd: "activate-tab", tab: tab.paneTab }).catch(() => {});
  }
}

async function closeTab(tab) {
  if (tab.host.kind === "window") {
    await tab.host.cdp.send("Target.closeTarget", { targetId: tab.targetId });
    return;
  }
  if (tab.paneTab === undefined) await syncPaneTabs(tab.host);
  await control(tab.host, { cmd: "close-tab", tab: tab.paneTab });
  forgetTab(tab.targetId);
}

// --- HTTP routes -------------------------------------------------------------

async function route(req) {
  const url = new URL(req.url, "http://x");
  const action = url.pathname.slice(1);
  const param = (name) => url.searchParams.get(name);
  const window = param("window") || undefined;

  if (action === "status") {
    await scanPanes();
    return {
      pid: process.pid,
      startedAt,
      hosts: [...hosts.values()].map((h) => ({
        id: h.id,
        kind: h.kind,
        port: h.port,
        browser: h.product,
        pid: h.pid,
        pane: h.pane || null,
        window: h.window || null,
      })),
      tabs: publicTabs().length,
    };
  }

  if (action === "open") {
    const target = param("url") || "about:blank";
    const owner = parseOwnerParam(param("owner"));
    const hostKind = param("host") === "window" ? "window" : "pane";
    return serially(() => openTab(target, { hostKind, window, fresh: param("new") === "1", watch: param("watch"), owner }));
  }

  if (action === "tabs") {
    await scanPanes();
    await refreshTargets();
    const active = await activeTab(window);
    return publicTabs().map((t) => describeTab(t, active));
  }

  if (action === "reload") {
    const tab = await tabOrActive(param("id"), window);
    await controllerFor(tab).reload();
    lastTouched = tab.targetId;
    return describeTab(tab, await activeTab(window));
  }

  if (action === "close") {
    const tab = findTab(param("id"));
    if (!tab) throw httpError(404, `no tab ${param("id")}`);
    await closeTab(tab);
    return { closed: tab.id };
  }

  if (action === "events") {
    const wait = Math.min(Number(param("wait") || 0), MAX_WAIT_SECONDS);
    return takeEvents({ tab: param("tab"), peek: param("peek") === "1", wait });
  }

  if (action === "cdp-url") {
    const tab = await tabOrActive(param("id"), window);
    return {
      id: tab.id,
      targetId: tab.targetId,
      url: `ws://127.0.0.1:${tab.host.port}/devtools/page/${tab.targetId}`,
    };
  }

  if (action === "comments") {
    const tab = await tabOrActive(param("id"), window);
    return { tab: tab.id, items: await evalOverlay(tab, "comments", []) };
  }

  if (action === "resolve") {
    const tab = await tabOrActive(param("id"), window);
    const commentId = param("comment");
    if (!commentId) throw httpError(400, "missing comment id");
    const { reply } = await readJsonBody(req);
    const ok = await evalOverlay(tab, "resolve", [commentId, typeof reply === "string" ? reply : ""]);
    if (!ok) throw httpError(404, `no comment ${commentId} on ${tab.id}`);
    return { tab: tab.id, resolved: commentId };
  }

  if (action === "notify") {
    await scanPanes();
    const tab = await tabOrActive(param("id"), window);
    const body = await readJsonBody(req);
    if (body && body.off) {
      tabOwners.set(tab.id, null);
      return { tab: tab.id, owner: null };
    }
    const owner = validateOwner(body);
    if (!owner) throw httpError(400, "bad owner payload");
    registerOwner(tab.id, owner);
    return { tab: tab.id, owner };
  }

  if (action === "doctor") return serially(() => doctor(window));

  throw httpError(404, `unknown action: ${action}`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw.length) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw httpError(400, "bad JSON body");
  }
}

// Calls a method on the page-side annotate overlay (window.__chromiumBridgeAnnotate),
// passing arguments as JSON literals in the expression so no raw text is ever
// concatenated into it. `undefined` distinguishes an overlay that never
// loaded from a legitimate falsy return value.
async function evalOverlay(tab, method, args) {
  const literal = args.map((a) => JSON.stringify(a)).join(", ");
  const expression = `(() => {
    const overlay = window.__chromiumBridgeAnnotate;
    return overlay ? overlay.${method}(${literal}) : undefined;
  })()`;
  const { result, exceptionDetails } = await controllerFor(tab).command("Runtime.evaluate", {
    expression,
    returnByValue: true,
  });
  if (exceptionDetails) throw httpError(500, exceptionDetails.exception?.description || exceptionDetails.text || "evaluate failed");
  if (result.value === undefined) throw httpError(409, `annotate overlay not loaded on ${tab.id}`);
  return result.value;
}

// Opens run one at a time, so concurrent opens of one page share a tab.
let openQueue = Promise.resolve();
function serially(fn) {
  const run = openQueue.then(fn, fn);
  openQueue = run.catch(() => {});
  return run;
}

// The page a URL names, for reuse: scheme, host, and path. Query and fragment
// may differ, and a match navigates to the new ones.
function pageKey(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/$/, "")}`;
  } catch {
    return url;
  }
}

function sameUrl(a, b) {
  const strip = (u) => u.replace(/#.*$/, "").replace(/\/$/, "");
  return strip(a) === strip(b);
}

// New tabs open on about:blank and navigate once the page controller is
// attached, so window.chromiumBridge exists before the page's own scripts run.
//
// The pane host is the terminal-browser in the caller's tmux window. With
// none there, the answer is {launch: true, url}: the CLI starts one on
// about:blank from its own pane and asks again, and that blank tab is the
// one taken over here.
async function openTab(target, { hostKind, window, fresh, watch, owner }) {
  if (watch && !isDirectory(watch)) throw httpError(400, `not a directory: ${watch}`);
  if (target.startsWith("file:")) target = await servedUrl(target);

  let host;
  if (hostKind === "window") {
    host = await attachChromium(true);
  } else {
    await scanPanes();
    const inWindow = paneHostsIn(window);
    host = inWindow.find((h) => [...tabs.values()].some((t) => t.host === h && t.targetId === lastTouched)) || inWindow[inWindow.length - 1];
    if (!host) return { launch: true, url: target };
    await syncPaneTabs(host);
  }

  const mine = publicTabs().filter((t) => t.host === host);
  const key = pageKey(target);
  const matches = fresh ? [] : mine.filter((t) => pageKey(t.url) === key);
  const reusable = prefer(matches);
  const blank = !reusable && host.kind === "pane" ? mine.find((t) => t.url === "about:blank") : undefined;

  let tab = reusable || blank;
  if (reusable) {
    const controller = controllerFor(tab);
    if (sameUrl(tab.url, target)) await controller.reload();
    else await controller.navigate(target);
  } else {
    if (!tab) tab = await newTab(host);
    try {
      await controllerFor(tab).navigate(target);
    } catch (err) {
      await closeTab(tab).catch(() => {});
      throw err;
    }
  }

  // Chromium reports the new url a moment after navigation. Record it now, so
  // the next open finds this tab.
  tab.url = target;
  lastTouched = tab.targetId;
  registerOwner(tab.id, owner); // the last opener wins
  if (watch) startWatch(tab, watch);

  // Select the tab in its window, never on a watch-triggered reload. A
  // fresh getTargets call picks up the title Chromium has settled on by now,
  // where cheap; a title mid-navigation isn't worth reporting as current.
  await selectTab(tab);
  await refreshTargets();
  const described = describeTab(tab, await activeTab(window));
  if (!tab.title) delete described.title;
  return { ...described, reused: Boolean(reusable) };
}

function isDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

// --- Watch -------------------------------------------------------------------

// Reload the tab whenever a file under `dir` changes, debounced so one save
// that touches several files reloads once.
function startWatch(tab, dir) {
  stopWatch(tab.targetId);
  const entry = { dir, timer: undefined };
  entry.watcher = fs.watch(dir, { recursive: true }, (_type, file) => {
    if (file && /(^|\/)(node_modules|\.git)(\/|$)/.test(file)) return;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => controllerFor(tab).reload().catch(() => {}), 150);
  });
  entry.watcher.on("error", () => stopWatch(tab.targetId));
  watchers.set(tab.targetId, entry);
}

function stopWatch(targetId) {
  const entry = watchers.get(targetId);
  if (!entry) return;
  clearTimeout(entry.timer);
  entry.watcher.close();
  watchers.delete(targetId);
}

// --- Local file server -------------------------------------------------------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function startFileServer() {
  if (!fileServer) {
    fileServer = http.createServer(serveFile);
    fileServer.ready = new Promise((resolve, reject) => {
      fileServer.once("error", reject);
      fileServer.listen(0, "127.0.0.1", resolve);
    });
  }
  return fileServer.ready;
}

// A file:// URL becomes the same file under the file server, rooted at its
// directory (or at itself, for a directory). One key per directory, so
// reopening the file maps to the same URL and reuses its tab.
async function servedUrl(fileUrl) {
  await startFileServer();
  const target = new URL(fileUrl);
  const filePath = decodeURIComponent(target.pathname);
  const isDir = isDirectory(filePath);
  const dir = isDir ? filePath : path.dirname(filePath);
  if (!servedKeys.has(dir)) {
    const key = crypto.randomBytes(12).toString("hex");
    servedKeys.set(dir, key);
    served.set(key, dir);
  }
  const name = isDir ? "" : encodeURIComponent(path.basename(filePath));
  return `http://127.0.0.1:${fileServer.address().port}/${servedKeys.get(dir)}/${name}${target.search}${target.hash}`;
}

// The local file behind a served URL, for listings.
function sourceFile(url) {
  try {
    const u = new URL(url);
    if (!fileServer || u.host !== `127.0.0.1:${fileServer.address().port}`) return null;
    const [, key, ...rest] = u.pathname.split("/");
    const dir = served.get(key);
    return dir ? path.join(dir, decodeURIComponent(rest.join("/"))) : null;
  } catch {
    return null;
  }
}

function serveFile(req, res) {
  const notFound = () => {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  };
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
  } catch {
    return notFound();
  }
  const [, key, ...rest] = pathname.split("/");
  const root = served.get(key);
  if (!root) return notFound();

  let file = path.resolve(root, rest.join("/"));
  if (file !== root && !file.startsWith(root + path.sep)) return notFound();
  if (isDirectory(file)) file = path.join(file, "index.html");

  fs.readFile(file, (err, body) => {
    if (err) return notFound();
    res.writeHead(200, {
      "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  });
}

// --- Events ------------------------------------------------------------------

function onPageEvent(tab, data) {
  if (tab.onEvent) return tab.onEvent(data);
  pushEvent(tab.id, tab.url, data);
}

function pushEvent(tab, url, data) {
  events.push({ seq: nextSeq++, tab, url, at: new Date().toISOString(), data });
  if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
  for (const waiter of waiters) {
    if (!waiter.tab || waiter.tab === tab) waiter.wake();
  }
  scheduleRing(tab);
}

// Return queued events, oldest first, and drop them unless peeking. With
// nothing queued, wait up to `wait` seconds for the first to arrive.
//
// A push wakes every matching waiter, but only the first to run afterward
// actually finds anything: the rest see events already taken. A waiter that
// wakes to nothing waits again for what's left of its own deadline, rather
// than returning empty-handed while time remains.
async function takeEvents({ tab, peek, wait }) {
  const matches = () => events.filter((e) => !tab || e.tab === tab);
  const deadline = Date.now() + wait * 1000;
  while (!matches().length && wait > 0 && Date.now() < deadline) {
    await waitForEvent(tab, deadline - Date.now());
  }
  const taken = matches();
  if (!peek) events = events.filter((e) => !taken.includes(e));
  return taken;
}

function waitForEvent(tab, timeoutMs) {
  return new Promise((resolve) => {
    const waiter = { tab, wake: () => done() };
    const timer = setTimeout(() => done(), timeoutMs);
    function done() {
      clearTimeout(timer);
      waiters.delete(waiter);
      resolve();
    }
    waiters.add(waiter);
  });
}

// --- Doorbell ----------------------------------------------------------------
//
// A pushed event rings the tab's registered pane, so an agent not blocked on
// `events --wait` still hears about it. The doorbell is a short prompt
// naming the tab; the events themselves stay in the queue for the agent to
// pull. A waiter that already claims an event drains it before the
// coalescing window below fires, so ring() finds nothing queued and rings
// for nothing -- that's what suppresses the doorbell when a wait is pending.

// An owner the CLI sent on `open` or `notify`: herdr needs a pane and the
// socket to reach it, tmux needs a pane and its server socket.
function validateOwner(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.kind === "herdr" && typeof raw.pane === "string" && raw.pane) {
    return {
      kind: "herdr",
      pane: raw.pane,
      socket: typeof raw.socket === "string" ? raw.socket : "",
      bin: typeof raw.bin === "string" && raw.bin ? raw.bin : "herdr",
    };
  }
  if (raw.kind === "tmux" && typeof raw.pane === "string" && raw.pane && typeof raw.socket === "string" && raw.socket) {
    return { kind: "tmux", pane: raw.pane, socket: raw.socket };
  }
  return null;
}

function parseOwnerParam(raw) {
  if (!raw) return null;
  try {
    return validateOwner(JSON.parse(raw));
  } catch {
    return null;
  }
}

function registerOwner(tabId, owner) {
  if (!owner) return;
  tabOwners.set(tabId, owner);
  lastOwner = owner;
}

function clearRing(tabId) {
  const timer = ringTimers.get(tabId);
  if (timer) clearTimeout(timer);
  ringTimers.delete(tabId);
  lastRung.delete(tabId);
}

// One timer per tab. A push while a timer is already pending joins the same
// window instead of resetting it, so a burst of sends rings once.
function scheduleRing(tabId) {
  if (ringTimers.has(tabId)) return;
  const timer = setTimeout(() => {
    ringTimers.delete(tabId);
    ring(tabId).catch((err) => log(`doorbell ${tabId} failed:`, err.message || err));
  }, RING_DELAY_MS);
  ringTimers.set(tabId, timer);
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function doorbellText(tabId, pending) {
  let comments = 0;
  let others = 0;
  for (const e of pending) {
    if (e.data && typeof e.data === "object" && e.data.type === "comments" && Array.isArray(e.data.items) && e.data.items.length) {
      comments += e.data.items.length;
    } else {
      others += 1;
    }
  }
  const readCmd = `chromium-bridge events --tab ${tabId}`;
  const resolveCmd = `chromium-bridge resolve ID "reply" --tab ${tabId}`;

  if (comments && others) {
    return `[chromium-bridge] The user sent ${plural(comments, "comment")} and the page sent ${plural(others, "message")} on ${tabId}. Read them with: ${readCmd}   (answer comments with: ${resolveCmd})`;
  }
  if (comments) {
    const it = comments === 1 ? "it" : "them";
    return `[chromium-bridge] The user sent ${plural(comments, "comment")} on ${tabId}. Read ${it} with: ${readCmd}   (answer each with: ${resolveCmd})`;
  }
  const it = others === 1 ? "it" : "them";
  return `[chromium-bridge] The page on ${tabId} sent ${plural(others, "message")}. Read ${it} with: ${readCmd}`;
}

// Gathers this tab's events still queued since the last ring, delivers one
// doorbell for them, and shows the page a toast reporting what happened.
// Events taken by an agent before this fires (whether through a wait or a
// plain `events` call) leave nothing to gather, so no doorbell rings.
async function ring(tabId) {
  const already = lastRung.get(tabId) || 0;
  const pending = events.filter((e) => e.tab === tabId && e.seq > already);
  if (!pending.length) return;
  lastRung.set(tabId, Math.max(...pending.map((e) => e.seq)));

  // An explicit null means `notify --off`: no doorbell, and no fallback.

  if (tabOwners.has(tabId) && tabOwners.get(tabId) === null) {
    log(`doorbell ${tabId}: off for this tab`);
    await notice(tabId, "Queued; the doorbell is off for this tab");
    return;
  }
  const owner = tabOwners.get(tabId) || lastOwner;
  if (!owner) {
    log(`doorbell ${tabId}: no owner registered`);
    await notice(tabId, "Queued; no agent is registered for this tab");
    return;
  }

  const text = doorbellText(tabId, pending);
  log(`doorbell ${tabId}: delivering via ${owner.kind} to ${owner.pane}`);
  const onHold = () => notice(tabId, "Held until the agent's input box is empty. Send or clear your draft there.");
  const result = await deliver(owner, text, onHold);
  if (result.ok) {
    log(`doorbell ${tabId}: delivered to ${result.label}`);
    await notice(tabId, `Sent to the agent (${result.label})`);
  } else {
    log(`doorbell ${tabId}: delivery failed: ${result.reason}`);
    await notice(tabId, `Queued, but no agent was reached: ${result.reason}`);
  }
}

// Reports a delivery attempt in the page itself, through the annotate
// overlay's toast. Best-effort: a tab with no overlay loaded (about:blank, a
// page mid-navigation) just logs and moves on.
async function notice(tabId, text) {
  const tab = findTab(tabId);
  if (!tab) return;
  try {
    await evalOverlay(tab, "notice", [text]);
  } catch (err) {
    log(`doorbell ${tabId}: notice failed:`, err.message || err);
  }
}

// --- Doorbell delivery adapters -----------------------------------------------
//
// Both run external commands with execFile, never a shell, so the doorbell
// text is always passed as a literal argument.

function deliver(owner, text, onHold) {
  if (owner.kind === "herdr") return deliverHerdr(owner, text, onHold);
  if (owner.kind === "tmux") return deliverTmux(owner, text);
  return Promise.resolve({ ok: false, reason: `unknown owner kind ${owner.kind}` });
}

function herdrRun(bin, args, env, timeout = HERDR_TIMEOUT_MS) {
  return execFileAsync(bin, args, { env, timeout, encoding: "utf8" }).then(
    ({ stdout, stderr }) => ({ ok: true, stdout, stderr }),
    (err) => ({ ok: false, stdout: err.stdout || "", stderr: err.stderr || String(err.message || err) }),
  );
}

// herdr rejects a prompt to a blocked agent with agent_blocked instead of
// queuing it; everything else (including a working agent) is submitted and
// lands queued for when the agent's current turn ends. A pane with no agent,
// or one that's gone, is never typed into.
async function deliverHerdr(owner, text, onHold) {
  const bin = owner.bin || "herdr";
  const env = { ...process.env };
  if (owner.socket) env.HERDR_SOCKET_PATH = owner.socket;

  const info = await herdrRun(bin, ["agent", "get", owner.pane], env);
  let agent;
  try {
    agent = info.ok && JSON.parse(info.stdout).result.agent;
  } catch {
    agent = null;
  }
  if (!agent || !agent.agent) return { ok: false, reason: "no agent in pane" };

  await waitForEmptyInput(bin, owner.pane, agent.agent, env, onHold);
  let attempt = await herdrRun(bin, ["agent", "prompt", owner.pane, text], env);
  if (!attempt.ok && /agent_blocked/.test(attempt.stdout + attempt.stderr)) {
    const waited = await herdrRun(
      bin,
      ["agent", "wait", owner.pane, "--until", "idle", "--until", "working", "--until", "done", "--timeout", String(HERDR_WAIT_TIMEOUT_MS)],
      env,
      HERDR_WAIT_TIMEOUT_MS + 5000,
    );
    if (!waited.ok) return { ok: false, reason: "agent stayed blocked" };
    attempt = await herdrRun(bin, ["agent", "prompt", owner.pane, text], env);
  }
  if (!attempt.ok) return { ok: false, reason: (attempt.stderr || attempt.stdout).trim().slice(0, 200) || "prompt rejected" };
  return { ok: true, label: `${agent.agent} in ${owner.pane}` };
}

// herdr types the doorbell into the agent's input box and presses Enter, so
// a draft already there would be sent along with it. For agents whose input
// box can be read off the screen, delivery waits until the box is empty.
// Agents without a detector, and screens a detector can't read, deliver at
// once.

const DRAFT_DETECTORS = { pi: piInputState };

// Pi draws its input box between the last two full-width horizontal rules.
function piInputState(screen) {
  const lines = screen.split("\n");
  const rules = [];
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.length >= 20 && /^\u2500+$/.test(trimmed)) rules.push(i);
  });
  if (rules.length < 2) return "unknown";
  const [top, bottom] = rules.slice(-2);
  return lines.slice(top + 1, bottom).some((line) => line.trim()) ? "draft" : "empty";
}

async function waitForEmptyInput(bin, pane, agentKind, env, onHold) {
  const detect = DRAFT_DETECTORS[agentKind];
  if (!detect) return;
  const deadline = Date.now() + DRAFT_HOLD_MAX_MS;
  let held = false;
  while (Date.now() < deadline) {
    const read = await herdrRun(bin, ["pane", "read", pane, "--source", "visible", "--format", "text"], env);
    if (!read.ok || detect(read.stdout) !== "draft") return;
    if (!held) {
      held = true;
      log(`doorbell: holding for a draft in ${pane}`);
      onHold();
    }
    await sleep(DRAFT_POLL_MS);
  }
  log(`doorbell: draft in ${pane} outlasted the hold; delivering anyway`);
}

function tmuxRun(socket, args) {
  return execFileAsync("tmux", ["-S", socket, ...args], { timeout: TMUX_TIMEOUT_MS, encoding: "utf8" }).then(
    ({ stdout, stderr }) => ({ ok: true, stdout, stderr }),
    (err) => ({ ok: false, stdout: err.stdout || "", stderr: err.stderr || String(err.message || err) }),
  );
}

// Types the doorbell text into the pane only once the guards pass: the pane
// still exists, it isn't in copy/search mode, and it isn't running a bare
// shell (nothing there to read the text).
async function deliverTmux(owner, text) {
  const pane = owner.pane;
  const exists = await tmuxRun(owner.socket, ["display-message", "-p", "-t", pane, "#{pane_id}"]);
  if (!exists.ok || !exists.stdout.trim()) return { ok: false, reason: "pane not found" };

  const state = await tmuxRun(owner.socket, ["display-message", "-p", "-t", pane, "#{pane_in_mode}\t#{pane_current_command}"]);
  if (!state.ok) return { ok: false, reason: "could not read pane state" };
  const [inMode, command] = state.stdout.trim().split("\t");
  if (inMode !== "0") return { ok: false, reason: "pane is in a mode" };
  if (TMUX_SHELLS.has(command)) return { ok: false, reason: `pane is running a shell (${command})` };

  const keys = await tmuxRun(owner.socket, ["send-keys", "-t", pane, "-l", text]);
  if (!keys.ok) return { ok: false, reason: "send-keys failed" };
  const enter = await tmuxRun(owner.socket, ["send-keys", "-t", pane, "Enter"]);
  if (!enter.ok) return { ok: false, reason: "send-keys (Enter) failed" };
  return { ok: true, label: pane };
}

// --- Doctor ------------------------------------------------------------------

// Prove the whole path: browser answers, attach, CDP round-trip, a send
// through the channel. On the pane host in the caller's window that runs on
// its selected tab and changes nothing; with no pane host it runs on a
// hidden Chromium tab, launching Chromium if needed. Each step reports how
// long it took. The doctor's own event never reaches the queue.
async function doctor(window) {
  const steps = [];
  const timed = async (name, fn) => {
    const start = Date.now();
    try {
      const result = await fn();
      steps.push({ step: name, ok: true, ms: Date.now() - start });
      return result;
    } catch (err) {
      steps.push({ step: name, ok: false, error: String(err.message || err) });
      throw err;
    }
  };

  await scanPanes();
  const pane = paneHostsIn(window)[0] || (window ? undefined : paneHosts()[0]);
  let host = pane;
  let tab;
  let version;
  try {
    if (pane) {
      tab = await timed("browser", () => activePaneTab([pane]));
      if (!tab) throw new Error("no tab in the pane");
    } else {
      host = await timed("browser", () => attachChromium(true));
      tab = await timed("open", () => newTab(host));
      tab.hidden = true;
    }
    await timed("attach", () => controllerFor(tab).ready);
    version = await timed("cdp-roundtrip", () => tab.controller.command("Browser.getVersion"));
    await timed("channel", () => channelRoundTrip(tab));
  } catch {
    // The failing step is already in `steps`.
  } finally {
    if (tab && tab.hidden) await timed("close", () => closeTab(tab)).catch(() => {});
  }
  return {
    ok: steps.every((s) => s.ok),
    host: host ? hostLabel(host) : null,
    version: version ? version.product : host && host.product,
    steps,
  };
}

async function channelRoundTrip(tab) {
  const nonce = crypto.randomBytes(6).toString("hex");
  const arrived = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("event never arrived")), 3000);
    tab.onEvent = (data) => {
      if (data && data.doctor === nonce) {
        clearTimeout(timer);
        resolve();
      }
    };
  });
  try {
    const { exceptionDetails } = await tab.controller.command("Runtime.evaluate", {
      expression: `chromiumBridge.send({ doctor: "${nonce}" })`,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    await arrived;
  } finally {
    tab.onEvent = undefined;
  }
}

// --- Lifecycle ---------------------------------------------------------------

function socketAnswers() {
  return new Promise((resolve) => {
    const conn = net.connect(SOCKET);
    conn.once("connect", () => {
      conn.destroy();
      resolve(true);
    });
    conn.once("error", () => resolve(false));
  });
}

// One daemon per state folder. The lock file holds the owner's pid and is
// created atomically by hard-linking a finished temp file into place. A lock
// whose owner is no longer a running daemon is stale and removed.
function tryLock() {
  const tmp = `${LOCK_FILE}.${process.pid}`;
  fs.writeFileSync(tmp, String(process.pid));
  try {
    fs.linkSync(tmp, LOCK_FILE);
    return true;
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  let owner = 0;
  try {
    owner = Number(fs.readFileSync(LOCK_FILE, "utf8"));
  } catch {}
  if (!isDaemon(owner)) fs.rmSync(LOCK_FILE, { force: true });
  return false;
}

function isDaemon(pid) {
  if (!pid) return false;
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).includes("daemon.js");
  } catch {
    return false;
  }
}

// Take the lock, or wait for the daemon holding it to come up. Returns false
// when another daemon is serving the socket.
async function acquireLock() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await socketAnswers()) return false;
    if (tryLock()) return true;
    await sleep(200);
  }
  return false;
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function reply(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`shutting down: ${reason}`);
  for (const targetId of [...watchers.keys()]) stopWatch(targetId);
  if (fileServer) fileServer.close();
  if (server) server.close();
  if (ownsLock) {
    fs.rmSync(SOCKET, { force: true });
    fs.rmSync(LOCK_FILE, { force: true });
  }
  process.exit(0);
}

async function main() {
  const idleOk = process.argv.includes("--idle-ok");
  process.umask(0o077);
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });

  if (!(await acquireLock())) {
    log("another daemon is serving the socket; exiting");
    return 0;
  }
  ownsLock = true;
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("unhandledRejection", (err) => log("unhandled rejection:", err));

  await attachChromium(false).catch((err) => log("chromium attach failed:", err.message));
  await scanPanes();
  if (hosts.size === 0) {
    if (!idleOk) {
      log("no chromium-bridge browser is running");
      fs.rmSync(LOCK_FILE, { force: true });
      return EXIT_NO_BROWSER;
    }
    armIdleExit();
  }

  fs.rmSync(SOCKET, { force: true });
  server = http.createServer((req, res) => {
    route(req)
      .then((body) => reply(res, 200, body))
      .catch((err) => reply(res, err.status || 500, { error: String(err.message || err) }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(SOCKET, resolve);
  });
  fs.chmodSync(SOCKET, 0o600);
  log(`ready: ${hosts.size} host(s), pid ${process.pid}`);
}

main().then(
  (code) => {
    if (code !== undefined) process.exit(code);
  },
  (err) => {
    log("fatal:", err.message || err);
    if (ownsLock) fs.rmSync(LOCK_FILE, { force: true });
    process.exit(1);
  },
);
