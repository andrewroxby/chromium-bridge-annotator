// One persistent CDP session per tab, attached to the tab's page target.
//
// The daemon keeps a session of its own on every tab for two things: reload
// and navigate on the agent's behalf, and keep the page-to-shell channel
// alive. Agents attach their own sessions through cdp-url; CDP lets both
// coexist.
//
// The channel: Runtime.addBinding installs a global function whose calls reach
// this session as Runtime.bindingCalled, and a script registered for every new
// document wraps it as window.chromiumBridge.send(data). The binding and the
// script survive navigation for as long as this session lives.
//
// annotate.js, the annotation overlay, loads right after this script the
// same way: registered for every new document, then evaluated once into the
// document already loaded. BOOTSTRAP's resolve and comments are thin
// delegates, so chromiumBridge can be built and frozen before the overlay
// loads. On a pane host a flag goes in first, so the overlay sizes its
// controls for clicks that resolve to one point per terminal cell.

const fs = require("node:fs");
const path = require("node:path");

const BINDING = "__chromiumBridgeSend";
const MAX_PAYLOAD = 1024 * 1024;

const ANNOTATE_SCRIPT = fs.readFileSync(path.join(__dirname, "annotate.js"), "utf8");
const COARSE_FLAG = "window.__chromiumBridgeCoarse = true;";

const BOOTSTRAP = `(() => {
  if (window.chromiumBridge) return;
  const send = (data) => {
    if (typeof window.${BINDING} !== "function") throw new Error("chromium-bridge channel not attached");
    const payload = JSON.stringify(data === undefined ? null : data);
    if (payload.length > ${MAX_PAYLOAD}) throw new Error("chromium-bridge: payload over 1 MB");
    window.${BINDING}(payload);
  };
  const resolve = (id, reply) => {
    const overlay = window.__chromiumBridgeAnnotate;
    return overlay ? overlay.resolve(id, reply) : false;
  };
  const comments = () => {
    const overlay = window.__chromiumBridgeAnnotate;
    return overlay ? overlay.comments() : [];
  };
  Object.defineProperty(window, "chromiumBridge", { value: Object.freeze({ send, resolve, comments }) });
})();`;

class PageController {
  // cdp is the daemon's browser connection; onEvent(data) receives each
  // payload the page sends.
  constructor(cdp, targetId, onEvent, { coarse = false } = {}) {
    this.cdp = cdp;
    this.targetId = targetId;
    this.onEvent = onEvent;
    this.coarse = coarse;
    this.disposed = false;
    this.ready = this.attach();
  }

  async attach() {
    const { sessionId } = await this.cdp.send("Target.attachToTarget", {
      targetId: this.targetId,
      flatten: true,
    });
    this.sessionId = sessionId;
    if (this.disposed) {
      this.detach();
      throw new Error("tab closed while attaching");
    }
    this.cdp.sessions.set(sessionId, (msg) => this.receive(msg));

    await this.call("Page.enable");
    await this.call("Runtime.enable");
    await this.call("Runtime.addBinding", { name: BINDING });
    const scripts = [BOOTSTRAP, ...(this.coarse ? [COARSE_FLAG] : []), ANNOTATE_SCRIPT];
    for (const source of scripts) await this.call("Page.addScriptToEvaluateOnNewDocument", { source });
    for (const expression of scripts) await this.call("Runtime.evaluate", { expression });
  }

  receive(msg) {
    if (msg.method !== "Runtime.bindingCalled" || msg.params.name !== BINDING) return;
    const raw = msg.params.payload;
    if (raw.length > MAX_PAYLOAD) return;
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      data = raw;
    }
    this.onEvent(data);
  }

  call(method, params) {
    return this.cdp.send(method, params, this.sessionId);
  }

  // A CDP command on this tab's session, once the session is attached.
  async command(method, params) {
    await this.ready;
    return this.call(method, params);
  }

  async reload() {
    await this.command("Page.reload", { ignoreCache: true });
  }

  async navigate(url) {
    const result = await this.command("Page.navigate", { url });
    if (result.errorText) throw new Error(`navigate failed for ${url}: ${result.errorText}`);
  }

  detach() {
    this.cdp.sessions.delete(this.sessionId);
    this.cdp.send("Target.detachFromTarget", { sessionId: this.sessionId }).catch(() => {});
  }

  dispose() {
    this.disposed = true;
    if (this.sessionId) this.detach();
  }
}

module.exports = { PageController };
