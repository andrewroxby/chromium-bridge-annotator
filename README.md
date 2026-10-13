# chromium-bridge

chromium-bridge gives a coding agent in your terminal a shared browser that it can control and you can annotate. By default the browser is a pane in the agent's own tmux window, a real Chromium drawn inside the terminal. The agent opens a page there and reloads it as it edits. You answer from the page, by clicking a button the agent built or by ⌥-clicking any element to comment on it, and your answer arrives in the agent's terminal as a prompt.

Terminal agents such as Claude Code, Codex, and Pi work in text, and a dashboard, a chart, a form, or a mockup you can click isn't native to the terminal. chromium-bridge works with any agent that has a shell, through a CLI, with no plugin for any one agent.

For example, an agent that wants you to choose between two designs writes `ui/index.html` with a button for each, then runs:

```sh
chromium-bridge open ./ui/index.html --watch   # show the page in a pane beside the agent; reload it on every save
```

Each button reports back through `chromiumBridge`, an object chromium-bridge injects into every page:

```html
<button onclick="chromiumBridge.send({ choice: 'b' })">Use design B</button>
```

When you click, a one-line prompt appears in the agent's terminal. The agent reads `{"choice": "b"}` with `chromium-bridge events` and carries on. To point at something instead, ⌥-click (Option-click) the element, write "make this the primary button", and press Send. The agent gets the comment the same way, makes the change, and replies. The comment's pin turns green, and the reply shows under the comment in the page's tray.

Tested on Ungoogled Chromium 154 and terminal-browser 0.13.4 on macOS, with Pi under tmux.

## Why it exists

Agents already have good ways to drive a browser. Chrome DevTools MCP, Playwright MCP, agent-browser, and Claude in Chrome all let an agent open pages, click, read the console, and take screenshots. They let the agent operate a browser, but they give you no way to answer the agent from the page.

Existing annotation tools cover the other direction. Agentation and the stagewise toolbar let you click an element and leave a note for an agent. You add them to your own web app as a package, so they work on your app in development, and they hand notes over through an MCP server, an IDE integration, or the clipboard.

chromium-bridge is for the agent already working in your terminal:

- It works on any page, including a single HTML file the agent just wrote. Nothing is installed into the page's code.
- What you send lands in the agent's own terminal pane as a prompt, through herdr or tmux. No MCP server, IDE, extension, or copy-paste step is involved, so Pi, Claude Code, and Codex all work the same way.
- The agent answers each comment on the page. Its pin turns green, and the reply sits under your comment, tied to the element it's about.
- Driving stays with existing tools. `chromium-bridge connect` hands any tab to agent-browser, and any CDP client can attach.
- The window host runs on its own profile, so the agent never sees your logins.

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Usage](#usage)
- [Hosts](#hosts)
- [Annotate mode](#annotate-mode)
- [Notifying the agent](#notifying-the-agent)
- [How it works](#how-it-works)
- [Tiling](#tiling)
- [Known limits](#known-limits)
- [Troubleshooting](#troubleshooting)

## Requirements

- macOS. The window host launches with `open -g -n` and tiling uses the AeroSpace CLI, both macOS-only.
- tmux, a terminal that speaks the kitty graphics protocol (Ghostty does), and the [terminal-browser](https://github.com/zenbu-labs/terminal-browser) cask for the default pane host: `brew install --cask terminal-browser`.
- The [Ungoogled Chromium](https://ungoogled-software.github.io/) cask, only for `--window`: `brew install --cask ungoogled-chromium` (installs to `/Applications/Chromium.app`).
- Node.js 22 or later for the daemon, no dependencies. Node's built-in `WebSocket` client talks CDP directly.
- Python 3.9 or later for the CLI, standard library only.
- [agent-browser](https://github.com/vercel-labs/agent-browser), optional, for clicking, filling, and inspecting pages: `brew install agent-browser`. It connects to the bridge's own Chromium over CDP, so its own Chrome download is not needed.
- [AeroSpace](https://github.com/nikitabobko/AeroSpace), optional, only for `--tile`/`tile`: `brew install --cask nikitabobko/tap/aerospace`.

Annotate mode in a pane uses Option-click, which tmux passes through to the page. A tmux binding of your own on Option-click (for example, to open the hyperlink under the pointer) catches the click first, so make it pass the click through when the pane runs terminal-browser. The pane's `pane_current_command` starts with `terminal-browse`, so `#{m:terminal-browse*,#{pane_current_command}}` matches it in a tmux conditional. Without such a binding, no tmux change is needed.

## Install

```sh
brew install --cask terminal-browser
git clone https://github.com/andrewroxby/chromium-bridge-annotator.git chromium-bridge
ln -sf "$PWD/chromium-bridge/bin/chromium-bridge" ~/.local/bin/chromium-bridge   # any directory on PATH
```

`skill/SKILL.md` tells an agent when and how to use the tool. Link the `skill/` folder into each agent's skills directory:

```sh
ln -sfn "$PWD/chromium-bridge/skill" ~/.claude/skills/chromium-bridge   # Claude Code
ln -sfn "$PWD/chromium-bridge/skill" ~/.agents/skills/chromium-bridge   # Pi
ln -sfn "$PWD/chromium-bridge/skill" ~/.codex/skills/chromium-bridge    # Codex
```

terminal-browser sends usage telemetry and crash reports by default upstream. Turn both off with `terminal-browser config set telemetry.usage off` and `terminal-browser config set telemetry.crashReports off`.

Open a page once, then run `chromium-bridge doctor` from the same tmux window to confirm the channel round-trips. With no pane open, `doctor` falls back to the Chromium window host and launches it.

## Usage

```sh
chromium-bridge open ./ui/index.html --watch    # reload on every save
chromium-bridge events --wait                   # block until the page sends something
chromium-bridge open localhost:3000             # URLs and bare hosts work too
chromium-bridge open ./ui/index.html --window   # use the Chromium window host instead of a pane
chromium-bridge ls                               # tabs on every host, with a host column; * marks the active one
chromium-bridge reload t2
chromium-bridge close t2
chromium-bridge connect my-session               # bind an agent-browser session to a tab
agent-browser --session my-session snapshot      # then click, fill, eval, screenshot, console
chromium-bridge comments                         # list annotate-mode comments on a tab
chromium-bridge resolve c1 "Done"                # answer one
chromium-bridge notify                           # register this pane for doorbell notices (open does this too)
chromium-bridge doctor                           # CDP round-trip and channel on the host in this window
chromium-bridge tile                             # tile the Chromium window beside the focused one
chromium-bridge untile                           # float it again
```

Every command takes `--json`, before or after the subcommand. `open` selects the tab it opens or reuses, so it's the visible one on its host afterward.

| `open` flag | Effect |
|---|---|
| (none) | Reuse a tab already showing the page (reload, or navigate if the query differs); otherwise open a new tab |
| `--window` | Open in the Chromium window host instead of a pane |
| `--split {right,left,down,up}` | Where a new pane goes (default `right`); applies only when `open` creates a pane |
| `--size FRACTION` | Share of the tmux window a new pane takes, 0.2 to 0.95; applies only when `open` creates a pane |
| `--new` | Always open a new tab |
| `--watch` | Reload whenever a file beside the target changes |
| `--watch-dir DIR` | Reload whenever a file under DIR changes |
| `--tile` | Tile the Chromium window beside the focused window after opening; implies `--window` |

A page talks back with `window.chromiumBridge.send(data)`, which exists before the page's own scripts run. `data` must be JSON-serializable. `events` returns queued sends oldest first and removes them; `--peek` leaves them, `--tab ID` filters, and `--wait [SECONDS]` long-polls (default and cap 600). `open` and `doctor` start the daemon when it isn't running; every other command needs a browser already attached.

Driving a page (clicks, fills, screenshots, console) is agent-browser's job over the tab `connect` binds; chromium-bridge adds nothing there.

## Hosts

A host is the browser that shows the tabs. The default is the **pane host**, a terminal-browser instance drawn inside a tmux pane. The **window host**, a Chromium window on a private profile, is opt-in with `open --window`, and `--tile` implies it.

The pane moves with its tmux window, survives Ghostty restarts, and never needs window management. Tiling a separate window beside a Ghostty tab broke on every tab or window change, which is why the pane is the default.

`open TARGET` in a pane works like this:

- If the caller's tmux window already has a terminal-browser, the page becomes a tab there, or reuses the tab already showing it.
- Otherwise the CLI runs `terminal-browser open --split right about:blank` from the agent's pane, and the daemon takes over the blank tab. `window.chromiumBridge` therefore exists before the page's own scripts run.

A remote viewer cannot open frame files on the browser's machine, so it sees a pane only through inline frames (`TERMINAL_BROWSER_FRAMES=inline`). `open` picks the transport when it creates a pane: an explicit `TERMINAL_BROWSER_FRAMES` wins, and otherwise a tmux option `@viewer` containing `graphics=inline` (set by a viewer tracker, such as a script run from tmux's client hooks) turns inline on. terminal-browser builds the pane from tmux's environment, not the caller's, so the CLI sets the variable in the tmux session's environment for the length of the launch and then restores it. A pane keeps the transport it started with, so when an existing pane lacks the transport the viewer needs, `open` warns and the pane has to be closed and opened again.

`ls` shows each tab's host: `window`, or the tmux pane id such as `%158`.

"The active tab" is scoped to the caller's tmux window, since the CLI passes the window on every call. The daemon prefers the pane host in that window, then the Chromium window, then any pane host. `doctor` checks the pane host in the caller's window if there is one, with a channel round-trip on its active tab that changes nothing. Otherwise it checks the Chromium path, launching it if needed, and it reports which host it checked.

`connect`, `events`, `resolve`, `comments`, `notify`, `reload`, `close`, and `cdp-url` work the same on both hosts. You can also open a pane host by hand with `terminal-browser open URL --split right`, and the daemon attaches to it on the next command.

## Annotate mode

Every bridge tab carries an annotation overlay. You comment on elements, and the agent receives the comments as one batch.

1. Hold ⌥ (Option) in a pane, or ⌘ (Command) in a Chromium window. Move the pointer, and the element under it gets an outline and a label. In a pane the outline appears once the pointer moves with Option held, because a bare Option press sends nothing through a terminal.
2. ⌥-click it in a pane, or ⌘-click it in a window. The page never sees that click, so buttons don't fire and links don't open.
3. Type a comment, mark it Change or Question, and press Cmd+Enter. A numbered pin marks the spot, and the comment joins the tray.
4. Edit or delete drafts in the tray, then press Send.

Plain clicks always reach the page. The **Annotate** button in the corner opens the tray and counts unsent comments.

Both modifiers work on both hosts. tmux never passes Command in a mouse report, but it does pass Option, and terminal-browser forwards it as `altKey`, so a pane uses Option. In a window, Option-click also makes macOS hide the frontmost app, so ⌘ is the one to use there.

In a pane every click resolves to one point per terminal cell, so the overlay runs in a coarse mode there. Its buttons grow to about a cell, and a click that lands near a button in the open popover or tray, rather than on it, goes to the nearest one.

Send delivers one `events` entry:

```json
{"type": "comments",
 "page": {"url": "…", "title": "…", "viewport": {"w": 1280, "h": 800}, "scroll": {"x": 0, "y": 0}, "dpr": 2},
 "items": [{"id": "c1", "intent": "change", "comment": "Make this primary",
            "anchor": {"selector": "button#signup", "fx": 0.42, "fy": 0.5},
            "element": {"tag": "button", "name": "Sign up", "text": "Sign up", "html": "<button …>", "rect": {…}, "styles": {…}},
            "nearbyText": "…"}]}
```

The agent reads the batch from `events`, answers each comment, and confirms with `comments`:

```sh
chromium-bridge events --wait                     # the comments batch arrives here
chromium-bridge resolve c1 "Done: made it primary"
chromium-bridge comments                          # ids, statuses, replies
```

Pins are magenta while drafts, blue once sent, and green once resolved, with the reply shown in the tray. A pin turns grey when its element no longer exists.

- Comments live in the tab's `sessionStorage`, keyed by page, so they survive `--watch` reloads but not closing the tab.
- The payload never includes form field values, and it drops attributes that look like secrets.
- The overlay sits in a closed shadow root marked `aria-hidden`, so it stays out of page CSS and agent-browser snapshots.
- Pressing Send also rings the agent registered for the tab; see [Notifying the agent](#notifying-the-agent).

## Notifying the agent

A page puts events in the queue two ways: a page's own buttons call `chromiumBridge.send(data)`, and annotate mode's tray Send sends a batch of comments. Without an agent blocked on `events --wait`, those events just sit there until the next turn happens to look.

`chromium-bridge open` registers the caller's pane as the tab's owner, the pane the daemon rings when something arrives. `chromium-bridge notify [--tab ID] [--off]` does the same registration without opening anything, for a tab the user opened by hand or to move the doorbell to a different pane; `--off` stops ringing for a tab. The last opener or `notify` call wins, and a tab nobody registered falls back to whichever pane registered most recently.

When an event arrives with no `events --wait` already pending, the daemon waits about 500ms, gathers whatever is still queued for that tab, and rings once for the whole batch. A burst of sends within that window still produces one doorbell, and an event is never rung for twice. The doorbell carries no data, only a one-line notice naming the tab and the command to read it:

```
[chromium-bridge] The user sent 2 comments on t1. Read them with: chromium-bridge events --tab t1   (answer each with: chromium-bridge resolve ID "reply" --tab t1)
```

The events themselves still have to be pulled with `chromium-bridge events`. A doorbell that never lands loses nothing but time.

Delivery tries one of two adapters, matching how the registered pane was reached:

- **herdr.** `herdr agent prompt <pane> <text>` submits the notice. A working agent gets it queued for when the current turn ends; a blocked agent's prompt is rejected with `agent_blocked`, and the daemon waits for it to unblock (up to 10 minutes) and retries once. A pane with no agent, or one that's gone, is never typed into. For Pi, the daemon first reads the input box off the screen. While it holds unsent text, the doorbell waits, polling every 3 seconds for up to 10 minutes, so a draft is never sent along with the notice. The page says so in a toast. Agents without a detector get the doorbell at once.
- **tmux.** `tmux send-keys` types the notice and presses Enter, after checking the pane exists, isn't in a mode such as copy or search, and isn't running a bare shell (zsh, bash, sh, fish). A pane that fails any guard is left alone.

Either way, the page gets a toast reporting what happened: sent, queued because no agent could be reached, or queued because no agent is registered for the tab. The tray's Send button also toasts immediately on click, so the user sees something happened even before delivery finishes.

`chromium-bridge ls --json` reports each tab's registered owner.

## How it works

| Piece | Role |
|---|---|
| `daemon.js` | Resident process: one CDP connection per host, tab tracking, event queue, doorbell delivery, watchers, file server |
| `page.js` | One CDP session per tab: reload, navigate, carries `chromiumBridge.send`, and injects the overlay |
| `annotate.js` | Annotate mode: picker, comment tray, pins, and `chromiumBridge.resolve` / `comments` / `notice` |
| `skill/SKILL.md` | Agent-facing instructions |
| `bin/chromium-bridge` | CLI: talks to the daemon over a unix socket, starts pane hosts, drives agent-browser and AeroSpace |

- The daemon keeps one CDP connection per host. terminal-browser's Electron answers "Not supported" to `Target.createTarget` and ignores `Target.activateTarget`, so the daemon opens, selects, and closes pane tabs through terminal-browser's per-instance control socket (newline-delimited JSON: `open-tab`, `activate-tab`, `close-tab`, `targets`). It finds each socket with `terminal-browser ls --all --json`, which also reports the instance's CDP port, its tmux pane, and which tab is selected. CDP still carries the channel (`Runtime.addBinding` plus a script registered for every new document, as on the window host), reload, navigate, and the annotate overlay.
- The window host's Chromium runs on a dedicated profile under `${XDG_STATE_HOME:-~/.local/state}/chromium-bridge/profile`, so it never touches your own Chromium or its logins. The daemon launches it in the background (`open -g -n`) with `--no-startup-window`, so it never takes focus. `--use-mock-keychain` keeps it off the login keychain, the same default Puppeteer uses.
- `--remote-debugging-port=0` lets Chromium pick a free port; it writes the port to `DevToolsActivePort` in the profile, and the daemon reads that file.
- The daemon lives while any host does and exits 60 seconds after the last one goes. `open` and `doctor` start it with `--idle-ok`. Other commands still fail with "no chromium-bridge browser is running; open something first" when nothing is attached.
- CLI and daemon talk HTTP over a unix socket (`daemon.sock`) in the state folder, mode `0600`. There's no token; the socket's file permissions are the auth.
- Every page tab gets its own CDP session, held by the daemon for the tab's life. `Runtime.addBinding` installs a global function in the page whose calls reach that session as a `Runtime.bindingCalled` event, and a script registered for every new document wraps it as `window.chromiumBridge.send(data)`. The binding and script survive navigation. Agents attach their own CDP sessions separately through `connect`; CDP lets both coexist on the same tab.
- Tab ids (`t1`, `t2`, …) follow discovery order and last for the tab's life, mapped internally to the browser's own target ids.
- Doorbell delivery runs from the daemon with `child_process.execFile` and a timeout, never a shell, so the notice text is always passed as a literal argument.
- On the window host, CDP has no "selected tab" event, so the daemon asks each tab whether it's focused or visible (`document.hasFocus()`, `document.visibilityState`), and prefers focused, then visible, then the tab it last touched, then the newest. On a pane host, `terminal-browser ls --all --json` reports the selected tab directly.
- A second HTTP server serves local files over `http://127.0.0.1`, starting with the first local file opened. Each directory gets a random path key, and responses are `no-store`. A page can load siblings and subfolders of the file opened, but not its parents.
- `connect SESSION [TAB]` exists because agent-browser (0.38.2) treats any CDP URL as a browser endpoint and binds to whichever tab Chromium lists first, usually the newest. `connect` runs `agent-browser connect` against the tab's own CDP URL, then `agent-browser --pin-tab tab <targetId>` to switch explicitly and pin the session there, and checks the session landed on the right page. The pin makes agent-browser fail loudly with `tab_gone` if that tab closes, instead of silently falling back to another one. It overrides any stale tab agent-browser remembers from a reused session name. Switching tabs this way doesn't take focus from the terminal. `agent-browser --session S close` disconnects and leaves the tab open.

## Tiling

Tiling applies to the window host only. It is opt-in, through `--tile` on `open` (which implies `--window`), or `tile` and `untile` on their own. It pairs the bridge window with the window you had focused, normally your terminal, and returns focus there once tiled. `untile` floats the pair again. A pane host needs none of this, since the pane tiles inside tmux.

- chromium-bridge drives AeroSpace only through its CLI and needs no AeroSpace keybindings. It suits a config that floats windows by default and tiles on demand.
- AeroSpace treats each Ghostty tab as its own window, so the tile follows the tab that was focused when `tile` ran.
- Tiling acts on windows, so it works the same under tmux, herdr, or no multiplexer.

## Known limits

- The event queue lives in memory, so a daemon restart loses queued events.
- A daemon restart also renumbers tab ids and stops the file server, so open local pages must be reopened.
- Active-tab detection on the window host uses page visibility, so the selected tab in a window that is covered by other windows still counts as visible.
- Clicks in a pane resolve to one point per terminal cell, since tmux has no pixel mouse mode. That is fine for buttons and cards and too coarse for 6 px targets. The overlay's own controls allow for it; a page's own small controls may need a bigger target.
- Inside tmux, the page renders at devicePixelRatio 1, so text can look soft on a retina display. terminal-browser derives its scale from the terminal's pixel-size report, and tmux gives none.
- Nothing draws over mosh, which drops graphics escapes. Over ssh, inline frames draw but stutter while a page animates.
- Cmd chords never reach a pane, so bind Ctrl equivalents for reload, URL, find, and close-tab with `terminal-browser config set shortcuts.<command> <keys>`.
- Closing the pane, or pressing ctrl+q or ctrl+c in it, quits that terminal-browser instance.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `no chromium-bridge browser is running; open something first` | A command other than `open`/`doctor` ran with no browser up | Run `chromium-bridge open ...` or `chromium-bridge doctor` first |
| `terminal-browser not found; brew install --cask terminal-browser, or pass --window` | The pane host isn't installed | Install the cask, or use `--window` |
| terminal-browser opened but the daemon could not attach to it; see `daemon.log` | terminal-browser started, but the daemon could not reach it through `terminal-browser ls --all --json` or its CDP port | Read `daemon.log` in the state folder, then retry `open` |
| Option-click opens a link instead of picking an element | A tmux binding on Option-click catches the click before the page | Make the binding pass the click through when the pane runs terminal-browser; see [Requirements](#requirements) |
| Text in a pane looks soft | Inside tmux the page renders at devicePixelRatio 1 | Known limit; use `--window` when text clarity matters |
| `Chromium never opened its debug port; is the bridge profile open in another Chromium?` | Another process already has the bridge profile locked | Close it, or check for a stray Chromium process on that profile |
| `daemon did not come up; see <daemon.log>` | Node missing, too old, or the daemon crashed on startup | Check `node --version` (need 22+) and read the log |
| `agent-browser not found; install it or add it to PATH` | agent-browser isn't installed | `brew install agent-browser` |
| `connected but landed on …, expected …` | The tab navigated away between lookup and connect | Retry `connect`, or pass the tab id explicitly |
| `window.chromiumBridge` is undefined in a page | The tab loaded before the daemon attached its session | Reload the tab |
| `Queued; no agent is registered for this tab` | No pane is registered for the tab | Run `chromium-bridge notify` from the agent's pane |
| `Queued, but no agent was reached: <reason>` | The registered pane is gone, has no agent, or failed a tmux guard | Check the pane, then rerun `chromium-bridge notify` if it moved |
| `AeroSpace not responding` / tiling hangs | AeroSpace isn't running or lacks the Accessibility grant | Launch AeroSpace, grant Accessibility in System Settings (it's ad-hoc signed, so macOS won't prompt on its own) |
| `no focused window to tile beside` / `focus the window to tile beside, not the bridge browser` | No window had focus, or the bridge window itself had focus | Focus the window you want to tile beside, then retry |
| `tab_gone`, or any `agent-browser` call failing or acting on the wrong page | The pinned tab closed, or the session drifted | Rerun `chromium-bridge connect SESSION TAB` |

## License

MIT
