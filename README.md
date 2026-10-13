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

Push tags: `screen:change`, `screen:watch-state`, `screen:watch:<id>`.

## Privacy

This streams screen content to whoever the host is. Prefer app/window/region scope over whole
screen; frames are kept only locally and pruned; nothing leaves the Mac except through the host.

## Test

```bash
npm test    # coalescing, segment chaining, state classification (fake capture)
```
