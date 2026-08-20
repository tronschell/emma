# Product and architecture contract

## Process boundary

```text
sandboxed React renderer
        | allowlisted IPC
Electron main / preload
        | newline-delimited JSON over stdio
Rust host -> emma-core -> Markdown stores
        |
Zig agent -> OpenAI-compatible providers and lazy MCP tools
```

The renderer holds a live projection only. Electron owns windows, the global
shortcut, trusted-sender validation, and the narrow preload API. `emma-core`
owns parsing, validation, atomic persistence, and domain invariants. The Zig
sidecar owns transient agent runs, tool selection, and usage accounting; it can
mutate durable data only through an explicit validated host command.

Both renderer windows use `sandbox: true`, `contextIsolation: true`, and
`nodeIntegration: false`. A restrictive content-security policy is applied and
unused Electron permissions are denied. New windows are denied; validated
HTTP(S) links open in the system browser. Electron's single-instance lock keeps
the Markdown stores under one host writer.

## Threads and knowledge

Ordinary work belongs to a durable thread. Each thread has one destination
knowledge base for explicit writes and a deduplicated set of read-only source
bases for bounded retrieval. Saving remains explicit. A saved page is an
editable, exportable Markdown document with category, source-thread provenance,
added/analyzed timestamps, model, token counts, and subagent count.

Thread format 3 stores the destination and sources; formats 1–2 migrate to the
destination as their sole source. Knowledge-base format 2 stores user category
slugs; format 1 migrates with none. Learned categories are derived from pages.
Removing a user category never removes a page. The activity heatmap is computed
from durable message and page timestamps.

## Windows and shortcuts

The library is a resizable three-pane workspace with independently collapsible,
bounded, locally persisted rail widths. A double-tap of the physical left Option
key toggles a compact
always-on-top agent surface. Electron does not expose exact notch bounds, so
settings offer a centered below-notch surface or top-edge split rails with a
validated, click-through hardware-gap calibration. The original dither glow uses 24 discrete
CSS animation steps per second and stops under reduced motion. Enter submits an
ordinary thread message. The overlay exposes exactly three settings-backed
quick actions on `Command-1/2/3`; each can choose a destination, category,
prompt, and whether to save the analyzed result.

The overlay BrowserWindow is created lazily and destroyed on dismissal so a
hidden Chromium renderer is not retained. Its unsent draft remains in renderer
local storage and is restored on the next activation. If dismissal occurs while
a request is running, the hidden renderer is destroyed as soon as that request
settles so successful prompts cannot replay.

## Models and extensions

Provider configuration consists of an OpenAI-compatible base URL, model, and
credential environment-variable name. There is no Vercel login surface. The
OpenRouter catalog is fetched lazily through Zig and offers only free,
tool-capable models advertising a zero-data-retention endpoint. Selected turns
require no provider data collection and zero retention; otherwise they fail
closed.

MCP servers remain disconnected until needed. The model searches server/tool
metadata first and receives only the selected tool schema. First launch and
Settings can register existing agent skill/MCP locations without copying config
secrets. Local CSS-only plugins provide an immediately useful UI-overhaul seam;
remote resources are blocked. Executable extension behavior remains in selected
skills and MCP tools so its permission and context boundaries stay visible. See
`docs/plugins.md`.

## Current limits

The hotkey surface can capture a user-initiated display frame and draw yellow
highlights locally. Provider transmission remains disabled until the user
explicitly authorizes sending the whole visible frame to the selected endpoint.
General files, recurring jobs, and a generalized quick-action executor are not
implemented in this slice. Local Whisper/Parakeet-compatible
endpoint settings are present, but microphone capture and audio transport remain
disabled. Signing, notarization, VoiceOver verification, and non-macOS support
are release work.
