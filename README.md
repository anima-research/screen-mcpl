# screen-mcpl

Watch parts of the Mac screen and get woken when they change.

An [MCPL](https://github.com/anima-research/mcpl/blob/main/SPEC.md) server wrapping [Peekaboo](https://github.com/openclaw/Peekaboo)'s
`capture live` (ScreenCaptureKit + frame diff) and `see` (screenshot + accessibility map).
Each **watch** is a window, app, screen or region plus a change threshold. Bursts of change are
coalesced into **one** `push/event` carrying the latest frame (changed areas boxed) and the note
you gave when you started watching — so the wake explains itself.

```
screen_watch {app:"Safari", window:"GitHub", note:"waiting for CI on PR #7", threshold:1}
→ Watching Safari window "GitHub" as "safari" — baseline frame captured. You'll be woken when ≥1% changes…

   …later, as a push event:
[screen] Safari changed — 3 changes over 9s (14:02:10–14:02:19), watch "safari", first wake.
Note to self: waiting for CI on PR #7
Frame: ~/.screen-mcpl/captures/safari/pushed/push-0001.jpg (changed areas boxed)
+ inline JPEG
```

## Tools

| tool | what |
|---|---|
| `screen_watch` | start a watch: `app` (+`window`/`windowIndex`), `region "x,y,w,h"`, or `screen`; `note`, `threshold` %, `coalesceSeconds`, `maxHoldSeconds`, `minIntervalSeconds`, `image` inline/path/none, `highlight` |
| `screen_watches` | list watches with state, change/wake counts, Peekaboo permission status |
| `screen_watch_set` | pause/resume, retune threshold/coalescing/note/image on a running watch |
| `screen_unwatch` | stop one (`id`) or all (`"all"`) |
| `screen_look` | screenshot now; `elements:true` adds the AX element map, `ocr:true` adds text |
| `screen_apps` | running apps; with `app`, that app's windows (titles/ids/bounds) |

Watch states: `watching` · `waiting` (app/window not there yet — retries every 20 s) · `blocked`
(permission, locked session, capture failure — retries with backoff) · `paused`. A watch that was
working and stops gets one text wake saying why.

## How it runs

Peekaboo caps a live capture at 180 s, so each watch runs a chain of back-to-back segments
(≈0.5 s blind spot between them). Frame 1 of every segment is Peekaboo's forced baseline and is
never a change. Kept frames are read from disk as they land; the last frame of a burst is
downscaled with `sips` (no native deps) to `maxPx` (1024) and attached.

The pushed frame is rendered by `tools/framebox.swift` (compiled at `npm run build`, needs Xcode CLT):
it diffs against the previous pushed frame, boxes the changed regions in red and reports the %
changed. Without `swiftc` it falls back to `sips` (no boxes). Peekaboo's own `--highlight-changes`
is passed too but, as of 4.9.0, draws nothing.

Idle sampling is 1 fps, 4 fps during motion. Everything lives under `$SCREEN_MCPL_HOME`
(default `~/.screen-mcpl`): `config.json` (watches survive restarts), `captures/<watch>/seg-*`
(last 2 kept), `captures/<watch>/pushed/` (last 30 frames), `captures/_look/`.

## Install

```bash
brew install openclaw/tap/peekaboo   # 4.9+
npm install && npm run build
```

Grant **Screen Recording** (and **Accessibility** for `screen_look {elements:true}` / `screen_apps {app}`)
to **Terminal.app**. macOS attributes a capture to the responsible *app*; a daemon spawned from tmux or
launchd has none (no prompt, and the Screen Recording pane silently refuses bare binaries via "+").
So the server relaunches Peekaboo's daemon from Terminal.app (AppleScript) whenever it finds the grant
missing — Terminal's grant then covers every capture routed through the daemon. Capture is unavailable
while the GUI session is locked.

Bridge entry (`.mcpl-bridge.json`):

```json
"screen": {
  "transport": { "command": "node", "args": ["/path/to/screen-mcpl/dist/src/index.js", "--stdio"] },
  "grant": ["tools", "pushEvents"],
  "enableFeatureSets": ["*"]
}
```

Push tags: `screen:change`, `screen:watch-state`, `screen:watch:<id>`. The feature set declares
them in an RFC-001 `tagOntology` that suggests waking immediately on both kinds of push: the
watch already merges each burst, and is paced per watch with `screen_watch_set`. A host offers
the suggestions to its agent or operator and applies them only on acceptance.

## Input (optional)

Set `SCREEN_MCPL_INPUT=1` and three more tools are listed. Without it the tool list is unchanged.

| tool | what |
|---|---|
| `screen_click` | click at `x`,`y` (pixels of the last `screen_look` image) |
| `screen_type` | type `text` into whatever has keyboard focus in that window |
| `screen_press` | press `keys`: `"return"`, `"tab"`, `"pagedown"`, several separated by spaces |

They act on the app window the agent last captured with `screen_look` (a region or whole-screen
look selects no window). Everything is delivered through Peekaboo's background route: the pointer
does not move, the window does not come forward and it may be completely covered by other windows.
Results are text; the agent looks again to see what changed.

What the background route cannot do:

- A click presses the accessibility element under the point. A point with no pressable element
  (blank page area, a custom-drawn widget, a canvas) fails with an error that says so.
- App and menu shortcuts (`cmd+r`, `cmd+a`, `cmd+c` …) arrive in a web page as key events, but
  the app does not act on them. Use the toolbar buttons, and the page keys for scrolling.
- There is no wheel scrolling in Chrome; `pagedown` / `pageup` / `space` / arrow keys scroll.

Chrome has to be started with a few flags to be driven this way, so give the agent its own instance:

```bash
open -g -n -a "Google Chrome" --args --user-data-dir=/path/to/agent-profile \
  --force-renderer-accessibility \
  --disable-backgrounding-occluded-windows --disable-renderer-backgrounding \
  --disable-features=MacWebContentsOcclusion
```

`--force-renderer-accessibility` puts page content into the accessibility tree (without it every
click on a page fails). The other flags keep a covered window painting; without them clicks still
land but screenshots of a covered window go stale. With two Chrome instances running, name the
agent's one by process id: `screen_look {app:"PID:12345"}` (`screen_apps` lists pids). Launching
the instance brings it to the front once, despite `-g`.

Set `PEEKABOO_BRIDGE_SOCKET` to the daemon socket that holds the permissions (normally
`~/Library/Application Support/Peekaboo/daemon.sock`). Peekaboo can start a second, ungranted
daemon on its own; unpinned calls then reach that one and fail with a permission error.
**Event Synthesizing** must be granted alongside Accessibility.

`screen_look {elements:true}` fails on Chrome windows with Peekaboo 4.9.0 ("inconsistent response
evidence: window-context window title"); plain looks, which the input tools use, are unaffected.

## Privacy

This streams screen content to whoever the host is. Prefer app/window/region scope over whole
screen; frames are kept only locally and pruned; nothing leaves the Mac except through the host.

## Test

```bash
npm test    # coalescing, segment chaining, state classification (fake capture), the declared tag ontology
```
