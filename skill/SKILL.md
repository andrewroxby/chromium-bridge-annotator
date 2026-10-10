---
name: chromium-bridge
description: Show the user a GUI, HTML page, chart, or local web app in a browser pane beside the agent in tmux (or a dedicated Chromium window), iterate on it with live reload, collect the user's input or element-level comments from it as JSON, and drive or inspect it (snapshot, click, eval, screenshot, console) through agent-browser. Use when a visual surface beats terminal text, or when the user should answer through a form, picker, or other custom interface.
---

# chromium-bridge

`chromium-bridge` opens and controls browser tabs reserved for agents. By default the page opens in a pane beside the agent, in the same tmux window: a real Chromium drawn inside the terminal. New tabs for later pages appear in that pane, so the pane stays with the agent's tmux window. `open` and `doctor` start what they need; every other command needs a browser already attached.

Two exceptions use a separate Chromium window on its own profile, which never sees the user's everyday browser or logins. `open --window` opens one, and `open --tile` also tiles it beside the focused window through the AeroSpace CLI (`--tile` implies `--window`). The window never takes focus from the terminal.

## Show something and iterate

1. Write a self-contained HTML file (inline CSS and JS where practical).
2. `chromium-bridge open path/to/page.html --watch`
3. Edit the file. Every save reloads the tab.

Reopening the same page reuses its tab; pass `--new` for a second one. Local files are served over `http://127.0.0.1`, so ES modules and `fetch` of sibling files work. A page cannot load files above its own directory.

For a multi-file app with its own dev server, start the server and run `chromium-bridge open localhost:PORT`; its hot reload replaces `--watch` (or use `--watch-dir SRC`).

A new pane opens to the right of the agent's pane. `--split {right,left,down,up}` and `--size FRACTION` (0.2 to 0.95) change that, and they apply only when `open` creates a pane. A later `open` from the same tmux window adds a tab to the existing pane instead.

Pass `--window` only when the user wants a separate Chromium window, for example for sharper text or a target smaller than a terminal cell. Add `--tile` only when they want it beside the terminal. Leave the window floating otherwise.

## Hearing from the user

`open` registers this pane so the daemon can reach it; `notify` does the same without opening anything, for reattaching after the registered pane changes. Once registered, blocking on `events --wait` isn't the only way to hear from the user. When the page sends something with no wait already pending, the daemon drops a one-line prompt into this pane naming the tab and the command to run:

```
[chromium-bridge] The user sent 2 comments on t1. Read them with: chromium-bridge events --tab t1   (answer each with: chromium-bridge resolve ID "reply" --tab t1)
```

Run the command it names, act on what comes back, and resolve any comments. `events --wait` still has a place when a task should block until the user responds, such as a design choice that holds up everything else.

## Collect the user's input

Pages send JSON back:

```html
<button onclick="chromiumBridge.send({choice: 'b', note: document.querySelector('#note').value})">Submit</button>
```

```sh
chromium-bridge --json events --wait     # blocks until the page sends, up to 600s
```

`window.chromiumBridge` exists before the page's own scripts run. `events` returns sends oldest first and removes them; add `--peek` to leave them queued or `--tab ID` to filter. Tell the user what to do in the page. Wait on `events --wait` if the task should block, or carry on and let a doorbell prompt this pane once the pane is registered.

## Take comments on a page

The user can comment on elements directly. In a pane they ⌥-click (Option-click) an element, and in a Chromium window they ⌘-click it. They write a comment marked Change or Question and press Send in the corner tray. The batch arrives as one event:

```sh
chromium-bridge --json events --wait    # [{"data": {"type": "comments", "items": [...]}}]
```

Each item carries an `id`, `intent`, `comment`, an `anchor.selector`, and element context (tag, text, html, rect, styles). Work through the items, then answer each one so its pin turns green and shows your reply:

```sh
chromium-bridge resolve c1 "Done: made the button primary"
chromium-bridge comments      # ids, statuses, replies, to confirm it took
```

Answer Question items with a reply rather than a change. Comments survive `--watch` reloads, so resolve after your edit has reloaded the page. To invite comments, tell the user to "⌥-click (Option-click) an element" in a pane or "⌘-click" in a window, then press Send. `chromium-bridge ls` shows which one applies in its host column (`window`, or a tmux pane id such as `%158`); a registered pane gets a doorbell prompt once they do, so waiting on `events` is optional. Both commands act on the active tab by default, which is scoped to this tmux window: the pane host here first, then the Chromium window, then any pane host. With several tabs open, pass the event's `tab` value as `--tab`.

## Drive or inspect a page

```sh
chromium-bridge connect gui-task              # binds agent-browser session "gui-task" to the active tab
agent-browser --session gui-task snapshot     # accessibility tree with @e refs
agent-browser --session gui-task click @e3
agent-browser --session gui-task eval "document.title"
agent-browser --session gui-task screenshot /tmp/view.png
agent-browser --session gui-task console      # and `errors`, to debug the page
```

Pick one session name per task and reuse it on every call; a name of your own keeps you from sharing a session with another agent. Always bind with `chromium-bridge connect SESSION [TAB]`, never with `agent-browser connect` directly. agent-browser alone binds to whichever tab Chromium lists first, which is often the wrong one. `connect` binds the named tab (default: the active one), pins the session to it, and checks that it landed there. Run it again to move the session to another tab. `agent-browser --session gui-task close` disconnects when done and leaves the tab open.

If an agent-browser call fails (`tab_gone`, most often) or acts on the wrong page, rerun `chromium-bridge connect SESSION TAB` before retrying.

## Other commands

| Command | Effect |
|---|---|
| `chromium-bridge ls` | Tabs on every host, with a host column (`window`, or a tmux pane id); `*` marks the active one |
| `chromium-bridge reload [ID]` | Reload a tab (default: the active one) |
| `chromium-bridge close ID` | Close a tab |
| `chromium-bridge cdp-url [ID]` | CDP WebSocket URL for a tab (default: the active one) |
| `chromium-bridge comments [--tab ID]` | List annotate-mode comments on a tab |
| `chromium-bridge resolve ID [REPLY] [--tab ID]` | Answer an annotate-mode comment |
| `chromium-bridge notify [--tab ID] [--off]` | Register this pane for doorbell notices on a tab, or stop them |
| `chromium-bridge doctor` | End-to-end health check of the pane host in this tmux window, or of the Chromium window if there is none |
| `chromium-bridge tile` / `untile` | Tile or float the Chromium window beside the focused window |

Every command takes `--json`.

## Cleanup

Close scratch tabs once they've served their purpose; leave tabs the user is still using. Run `chromium-bridge untile` once the task is done if the session tiled a window. Closing the pane itself, or ctrl+q or ctrl+c inside it, quits that browser.

## When not to use it

- For the user's everyday web browsing, use their normal browser.

Design and troubleshooting are in the chromium-bridge README. The command's real path, from `readlink -f "$(command -v chromium-bridge)"`, ends in `bin/chromium-bridge`, and the README sits beside that `bin/` folder.
