# chromium-bridge

chromium-bridge lets coding agents drive a Chromium window from the command line, on a dedicated profile so it never touches your everyday browser or its logins.

Terminal agents such as Claude Code, Codex, and Pi work in text. A dashboard, a chart, a form, or a mockup you can click doesn't belong in a terminal UI. chromium-bridge gives any agent with a shell a place to render it, with no window juggling and no agent-specific plugin.

For example, an agent that wants you to choose between two designs writes `ui/index.html` with a button for each, then runs:

```sh
chromium-bridge open ./ui/index.html --watch   # open the page; reload it on every save
chromium-bridge events --wait                  # wait until the page reports your choice
```

Each button reports back through `chromiumBridge`, an object the daemon injects into every page:

```html
<button onclick="chromiumBridge.send({ choice: 'b' })">Use design B</button>
```

When you click, `events` prints `{"choice": "b"}` and the agent carries on. To click, fill, or inspect the page itself, the agent hands the tab to [agent-browser](https://github.com/vercel-labs/agent-browser).

Tested on Ungoogled Chromium 154 on macOS.

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Usage](#usage)
- [Annotate mode](#annotate-mode)
- [Notifying the agent](#notifying-the-agent)
- [How it works](#how-it-works)
- [Tiling](#tiling)
- [Known limits](#known-limits)
- [Troubleshooting](#troubleshooting)

## Requirements

- macOS. The launcher and tiling use `open -g -n` and the AeroSpace CLI, both macOS-only.
- The [Ungoogled Chromium](https://ungoogled-software.github.io/) cask: `brew install --cask ungoogled-chromium` (installs to `/Applications/Chromium.app`).
- Node.js 22 or later for the daemon, no dependencies. Node's built-in `WebSocket` client talks CDP directly.
- Python 3.9 or later for the CLI, standard library only.
- [agent-browser](https://github.com/vercel-labs/agent-browser), optional, for clicking, filling, and inspecting pages: `brew install agent-browser`. It connects to the bridge's own Chromium over CDP, so its own Chrome download is not needed.
- [AeroSpace](https://github.com/nikitabobko/AeroSpace), optional, only for `--tile`/`tile`: `brew install --cask nikitabobko/tap/aerospace`.

## Install

```sh
git clone <this-repo> chromium-bridge
ln -sf "$PWD/chromium-bridge/bin/chromium-bridge" ~/.local/bin/chromium-bridge   # any directory on PATH
```

`skill/SKILL.md` tells an agent when and how to use the tool. Link the `skill/` folder into each agent's skills directory:

```sh
ln -sfn "$PWD/chromium-bridge/skill" ~/.claude/skills/chromium-bridge   # Claude Code
ln -sfn "$PWD/chromium-bridge/skill" ~/.agents/skills/chromium-bridge   # Pi
ln -sfn "$PWD/chromium-bridge/skill" ~/.codex/skills/chromium-bridge    # Codex
```

Run `chromium-bridge doctor` once to confirm the browser launches and the channel round-trips.

## Usage

```sh
chromium-bridge open ./ui/index.html --watch    # reload on every save
chromium-bridge events --wait                   # block until the page sends something
chromium-bridge open localhost:3000             # URLs and bare hosts work too
chromium-bridge ls                               # tabs in the bridge window, * marks the active one
chromium-bridge reload t2
chromium-bridge close t2
chromium-bridge connect my-session               # bind an agent-browser session to a tab
agent-browser --session my-session snapshot      # then click, fill, eval, screenshot, console
chromium-bridge comments                         # list annotate-mode comments on a tab
chromium-bridge resolve c1 "Done"                # answer one
chromium-bridge notify                           # register this pane for doorbell notices (open does this too)
chromium-bridge doctor                           # open, CDP round-trip, channel, close
chromium-bridge tile                             # tile the window beside the focused one
chromium-bridge untile                           # float it again
```

Every command takes `--json`, before or after the subcommand. `open` selects the tab it opens or reuses, so it's the visible one in its window afterward.

| `open` flag | Effect |
|---|---|
| (none) | Reuse a tab already showing the page (reload, or navigate if the query differs); otherwise open a new tab |
| `--new` | Always open a new tab |
| `--watch` | Reload whenever a file beside the target changes |
| `--watch-dir DIR` | Reload whenever a file under DIR changes |
| `--tile` | Tile beside the focused window after opening |

A page talks back with `window.chromiumBridge.send(data)`, which exists before the page's own scripts run. `data` must be JSON-serializable. `events` returns queued sends oldest first and removes them; `--peek` leaves them, `--tab ID` filters, and `--wait [SECONDS]` long-polls (default and cap 600). `open` and `doctor` start the daemon and browser when neither is running; every other command needs a browser already up.

Driving a page (clicks, fills, screenshots, console) is agent-browser's job over the tab `connect` binds; chromium-bridge adds nothing there.

## Annotate mode

Every bridge tab carries an annotation overlay. You comment on elements, and the agent receives the comments as one batch.

1. Hold ⌘ (Command). The element under the cursor gets an outline and a label.
2. ⌘-click it. The page never sees that click, so buttons don't fire and links don't open.
3. Type a comment, mark it Change or Question, and press Cmd+Enter. A numbered pin marks the spot, and the comment joins the tray.
4. Edit or delete drafts in the tray, then press Send.

Plain clicks always reach the page. The **Annotate** button in the corner opens the tray and counts unsent comments.

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
| `daemon.js` | Resident process: one CDP connection to Chromium, tab tracking, event queue, doorbell delivery, watchers, file server |
| `page.js` | One CDP session per tab: reload, navigate, carries `chromiumBridge.send`, and injects the overlay |
| `annotate.js` | Annotate mode: picker, comment tray, pins, and `chromiumBridge.resolve` / `comments` / `notice` |
| `skill/SKILL.md` | Agent-facing instructions |
| `bin/chromium-bridge` | CLI: talks to the daemon over a unix socket, drives agent-browser and AeroSpace |

- Chromium runs on a dedicated profile under `${XDG_STATE_HOME:-~/.local/state}/chromium-bridge/profile`, so it never touches your own Chromium or its logins. The daemon launches it in the background (`open -g -n`) with `--no-startup-window`, so it never takes focus. `--use-mock-keychain` keeps it off the login keychain, the same default Puppeteer uses.
- `--remote-debugging-port=0` lets Chromium pick a free port; it writes the port to `DevToolsActivePort` in the profile, and the daemon reads that file.
- The daemon lives exactly as long as the browser. It exits once Chromium quits, and `open` and `doctor` start both when neither is running.
- CLI and daemon talk HTTP over a unix socket (`daemon.sock`) in the state folder, mode `0600`. There's no token; the socket's file permissions are the auth.
- Every page tab gets its own CDP session, held by the daemon for the tab's life. `Runtime.addBinding` installs a global function in the page whose calls reach that session as a `Runtime.bindingCalled` event, and a script registered for every new document wraps it as `window.chromiumBridge.send(data)`. The binding and script survive navigation. Agents attach their own CDP sessions separately through `connect`; CDP lets both coexist on the same tab.
- Tab ids (`t1`, `t2`, …) follow discovery order and last for the tab's life, mapped internally to Chromium's own target ids.
- Doorbell delivery runs from the daemon with `child_process.execFile` and a timeout, never a shell, so the notice text is always passed as a literal argument.
- CDP has no "selected tab" event, so the daemon asks each tab whether it's focused or visible (`document.hasFocus()`, `document.visibilityState`), and prefers focused, then visible, then the tab it last touched, then the newest.
- A second HTTP server serves local files over `http://127.0.0.1`, starting with the first local file opened. Each directory gets a random path key, and responses are `no-store`. A page can load siblings and subfolders of the file opened, but not its parents.
- `connect SESSION [TAB]` exists because agent-browser (0.38.2) treats any CDP URL as a browser endpoint and binds to whichever tab Chromium lists first, usually the newest. `connect` runs `agent-browser connect` against the tab's own CDP URL, then `agent-browser --pin-tab tab <targetId>` to switch explicitly and pin the session there, and checks the session landed on the right page. The pin makes agent-browser fail loudly with `tab_gone` if that tab closes, instead of silently falling back to another one. It overrides any stale tab agent-browser remembers from a reused session name. Switching tabs this way doesn't take focus from the terminal. `agent-browser --session S close` disconnects and leaves the tab open.

## Tiling

Tiling is opt-in, through `--tile` on `open`, or `tile` and `untile` on their own. It pairs the bridge window with the window you had focused, normally your terminal, and returns focus there once tiled. `untile` floats the pair again.

- chromium-bridge drives AeroSpace only through its CLI and needs no AeroSpace keybindings. It suits a config that floats windows by default and tiles on demand.
- AeroSpace treats each Ghostty tab as its own window, so the tile follows the tab that was focused when `tile` ran.
- Tiling acts on windows, so it works the same under tmux, herdr, or no multiplexer.

## Known limits

- The event queue lives in memory, so a daemon restart loses queued events.
- A daemon restart also renumbers tab ids and stops the file server, so open local pages must be reopened.
- Active-tab detection uses page visibility, so the selected tab in a window that is covered by other windows still counts as visible.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `no chromium-bridge browser is running; open something first` | A command other than `open`/`doctor` ran with no browser up | Run `chromium-bridge open ...` or `chromium-bridge doctor` first |
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
