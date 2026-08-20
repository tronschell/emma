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
added/analyzed timestamps, model, token counts, and subagent count. Each new
assistant message also keeps its output-token count and elapsed generation time
so the transcript can show that response's tokens-per-second rate.

Thread format 4 adds per-message generation telemetry; format 3 stores the
destination and sources, while formats 1–2 migrate to the destination as their
sole source. Knowledge-base format 2 stores user category
slugs; format 1 migrates with none. Learned categories are derived from pages.
Removing a user category never removes a page. The activity heatmap is computed
from durable message and page timestamps.

The Agent dashboard is a deterministic 60-day projection of those same local
records. It ranks collected source domains and repeated base/category mappings,
keeps page titles as expandable evidence, and never writes on its own. An
approved discovery proposal creates an atomic Markdown scheduled-job record.
The Rust worker evaluates its validated five-field UTC cron expression while
Emma is running, claims each occurrence before starting work, and opens a normal
durable thread for the result. Jobs never save knowledge or create skills
silently; enable/disable changes cross the same validated host boundary.

## Dynamic knowledge artifacts

A knowledge page is an ordered, agent-authored artifact document, not a flat
note. One page can interleave captured source material, summaries, citations,
tables, graphs, generated visuals, and plugin-defined interactive views. Every
artifact block keeps its type, version, source provenance, and a portable
Markdown/data fallback so export never depends on Emma or a particular plugin.

Capture may start from a browser page, selected text, a file or folder, a
screenshot or annotation, or context explicitly shared from another app. The
user's capture/save action authorizes a durable write; sending that material to
a model or connector remains a separate permission boundary. The agent may add,
edit, remove, and reorder blocks through validated host commands, including when
it revisits research and produces a better visualization or synthesis.

Built-in blocks stay declarative. A plugin renderer receives only its validated
artifact payload and declared capabilities, never ambient filesystem access,
provider credentials, or the full knowledge store. Unknown or unavailable block
types render their portable fallback instead of making the page unreadable.

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
Pages now persist bounded ordered declarative artifact blocks with rich-text,
list, citations/table, and chart/data payloads plus portable fallbacks; v1/v2
pages migrate on load. Plugin renderer execution and a generalized artifact
renderer SDK are not implemented yet, so unknown blocks use their fallback.
Generalized file/web capture is still outside this slice. Scheduled jobs run only while Emma is open; missed
occurrences coalesce into one due run when Emma next starts. A generalized
quick-action executor is outside this slice. Local Whisper/Parakeet-compatible
endpoint settings are present, but microphone capture and audio transport remain
disabled. Signing, notarization, VoiceOver verification, and non-macOS support
are release work.
