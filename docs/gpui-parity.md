# GPUI renderer parity inventory

This is the baseline inventory for the Electron renderer on branch `dev`. It is intentionally a parity contract, not a redesign. Every listed surface, state, interaction, dimension, token, asset, and test is part of the GPUI port acceptance bar.

The GPUI implementation should use [GPUI](https://gpui.rs/) for the window, element, event, focus, text, and rendering primitives and [gpui-component](https://github.com/longbridge/gpui-component) for the component behavior where it fits. The component catalog includes buttons, inputs, textareas, editors, menus, dialogs, popovers, lists, virtual lists, tables, trees, tabs, sliders, color pickers, charts, resizable panels, sidebars, notifications, markdown/text views, and dock layouts. Use the existing renderer as the visual authority: its dimensions and semantic tokens are the source of truth.

## Current boundary and migration constraints

- `desktop/src/main.tsx` mounts `<App />`, imports `desktop/src/boot.ts`, and imports `desktop/src/index.css`.
- `desktop/src/App.tsx` owns routing, the workspace shell, transcript, composer, settings, setup, and every overlay.
- `desktop/src` has no GPUI implementation today. The migration therefore needs a Rust GPUI application target and a typed bridge to the existing host/core/harness; it is not a JSX-to-Rust file rename.
- `desktop/main` and the preload bridge remain the Electron authority until their responsibilities are deliberately moved to native Rust windows, menus, process, filesystem, network, image, and model boundaries. Do not reimplement those trust boundaries in a renderer.
- `desktop/src/regions.tsx`, `desktop/src/artifacts.tsx`, `desktop/src/components.tsx`, `desktop/src/visual.tsx`, and `desktop/src/preview.tsx` execute or display dynamic content. Any GPUI replacement must preserve sandboxing, capability checks, path containment, size limits, and post-message/SQL behavior before visual parity is considered complete.
- Preserve the existing persistent keys and wire formats: layout, drafts, folders, modes, context uses/breakdown, cached blocks, attachments, clear markers, context pages, appearance, keybinds, overlay drafts, model/catalog/provider settings, editor choice, folder hues, free-model filter, maker order, and improvement state.

## Route and window matrix

### Window selection

`desktop/src/boot.ts` treats the URL query as a window discriminator. A normal workspace window renders `Workspace`; each query surface renders a dedicated lightweight window:

| Query surface | Current component | GPUI requirement |
| --- | --- | --- |
| no overlay query | `Workspace` in `desktop/src/App.tsx` | Main native window with persisted dock layout and the same title-bar/drag geometry. |
| `annotation` | `ScreenAnnotation` | Transparent always-on-top drawing window, screen capture, app metadata, pointer drawing, save/discard, Escape/close. |
| `hotspot` | `NotchHotspot` | Borderless hotspot window positioned at the notch/island, hover/open behavior, reduced-motion style. |
| `radial` | `RadialCommands` | Borderless command ring with keyboard/pointer selection, selected item, and quick-action dispatch. |
| `run` | `ComputerRunBanner` | Target-relative progress banner with bounded metadata and lifecycle hide. |
| `computerCursor` | `ComputerActivityCursor` | Target-relative cursor cue with readiness/expiry/abort handling and reduced motion. |
| `overlay` | `Overlay` | Notch/island quick-ask window, live transcript, model/mode menus, slash/@ menu, dictation, annotation chip, drag/resize/dismiss, migration to workspace. |

### Workspace navigation

`desktop/src/layout.ts` defines `NAV_VIEWS = ["knowledge", "artifacts", "scheduled", "agent", "plugins", "research"]`. `Workspace` in `desktop/src/App.tsx` selects these views plus `threads`, `archive`, and `settings`. Main-pane routing must preserve these exact IDs and the persisted `navOrder`, `projectOrder`, collapsed state, icon mode, and selected thread.

The workspace layout is a three-column main grid plus an optional terminal row:

- sidebar default 260 px, valid 200–340 px;
- inspector default 288 px, valid 260–360 px;
- browser default 420 px, valid 260–720 px;
- browser minimum 260 px, wide browser 720 px;
- terminal height is bounded by `shared/terminal` defaults/minimum/maximum and is capped at 60% of the thread layout;
- fixed-width/viewport slack redistribution is defined by `validatePaneLayout` in `desktop/src/layout.ts`;
- resize handles persist layout and all resizes must clamp identically.

The workspace must retain snapshot loading/error/stale refresh, maximum-50 history back/forward trail, sidebar search, project/folder connect/forget, thread selection with Shift/Meta/Ctrl range semantics, double-click rename, pin/unread toggles, context menus, project/tag copy/archive/bench actions, sortable navigation/project drag-and-drop, scheduled-thread access, model restoration/fallback, toasts, onboarding/import dialogs, update-ready notice, preview host, dynamic built components, browser/terminal/inspector pane toggles, and focus restoration.

## Screen and component inventory

The file paths below are the current source of truth. The state and interaction columns are parity requirements; the GPUI target column names the intended primitive or a justified custom element/entity.

### Shared shell and conversation (`desktop/src/App.tsx`)

| Current surface | State and behavior to preserve | GPUI target |
| --- | --- | --- |
| `ThreadStatus`, `Body`, `Thought`, `CopyTurn` | Tool/running/waiting/failed/done/idle labels; text/thinking split; copy action and accessible label. | Stable status/badge plus `TextView`/custom markdown and `Button`; live state is entity-backed. |
| `TranscriptRail`, `ContextCut`, `ModelCut`, `ProjectRules`, `MessageTray` | Message-position rail, context/model separators, AGENTS rules disclosure, attachment tray. | Virtualized `MessageScroller`/`VirtualList`; stable message IDs; attachment `Attachment`/`Image`; preserve scroll anchoring. |
| `Turn`, `Blocks`, `ContextNotice`, `Stalled` | User/assistant/system turns, text/thinking/tool blocks, compaction/experiment notices, stalled timers and model swap. | Compound message view over `Message`/`MessageScroller`; `Collapsible` for thought/tool details; timer tasks held in entity. |
| `StepTitle`, `StepMark`, `Steps`, `Step`, `EditStep`, `EditCount`, `Review` | Tool kind/path marks, pending/in-progress/completed/failed/cancelled, grouped calls, edit diff/status/count, review actions. | Virtualized grouped list, `Badge`/`Progress`/`Collapsible`; custom diff renderer only where native editor/table cannot reproduce line-level display. |
| `Streaming`, `AgentTranscript`, `PastAgentPanel` | Live blocks, nested agents, past agent transcript loading/error, stop/steer/open actions. | `MessageScroller` with per-agent entities; `Tabs`, `Dialog`, `Progress`, and accessible stop/steer buttons. |
| `ThreadView` | Transcript and composer; thread loading/error; subthread loading; inspector/browser/terminal; queued turns; context ledger; agent tabs; model/mode switching; attachments; quote; tag; context pages; all sends and stops. | Root `Render` entity coordinating child entities. Use `Textarea` for composer, `MessageScroller`, `Resizable`, `Tabs`, `Popover`/`Menu`, `Dialog`, `DockArea` only if its persistence model can match `PaneLayout`. |
| `ProjectBar`, `PickTray`, `CapabilityPopover`, `TagPicker`, `DropVeil`, `SelectionQuote` | Project folder chips; one-folder constraint; context picks; imported skill/MCP attachment; slash/@ context search; global file drop; text-selection quote menu; tags. | `Popover`, `Combobox`, `Attachment`, `Menu`, typed drag/drop and keyboard alternatives; preserve draft/pick persistence. |
| `ThreadStatsExport`, `AgentDialog` | Export stats; nested agent detail modal. | `Dialog`, `DescriptionList`, `TextView`, copy/save actions. |
| `ThreadLoading`, `AgentTranscriptLoading`, `AgentLoading` | Loading copy, retry/new-thread actions, target-specific stale response protection. | `Skeleton`/`Spinner`/`Alert`, GPUI `Task` cancellation and keyed entities. |

### Main navigation, archive, knowledge, schedule (`desktop/src/App.tsx`, `desktop/src/schedule.tsx`, `desktop/src/goal.tsx`)

| Surface | State and interaction | GPUI target |
| --- | --- | --- |
| Sidebar/project/thread rail | Pinned navigation, project hierarchy, folders/tags, unread/live states, scheduled indicators, archive, search, context menus, collapse/icon-only mode, drag reorder, resize, keyboard shortcuts including Cmd/Ctrl+1–9. | `Sidebar`, `Tree`/`VirtualList`, `Menu`, `Popover`, `Resizable`; custom row presentation to match 28 px rows, 46 px header, 228/200 px menus, exact tokens. |
| `TaskEditor`, `TaskGraphView`, `ScheduledView` | Create/edit/delete scheduled jobs, inherited/pinned model, workflow nodes/edges, runs, enabled state, validation, open thread. | `Form`, `Textarea`, `Select`/`Combobox`, `NumberInput`, `DatePicker` where appropriate, custom workflow graph element backed by the existing `placeRows`/`edgePath` geometry. |
| `TriggerPicker` | Minutes/hourly/daily/weekly/monthly/yearly/manual/cron; time/date/numeric selectors; UTC/local hint; raw custom cron; validation and disabled controls. | `Select`, `Input`, `NumberInput`, `DatePicker`, `Popover`; retain listbox keyboard behavior: arrows, Home/End, typeahead, Esc, Tab, outside click, focus restore. |
| `PromptField` | Multiline task prompt, slash/@ completion, IME composition guard, arrow/Enter/Tab/Esc selection, token highlighting. | `Textarea` or `Editor` with controlled completion `Popover`; UTF-8/UTF-16/IME/caret geometry must match native editor semantics. |
| `WorkflowGraph` | Node kinds agent/script/set/if, selected node, edge paths, error markers, empty/broken graph. | Custom GPU vector/paint layer over semantic selectable node elements; do not sacrifice keyboard node traversal or textual error access. |
| `ArchiveView`, `ProjectSweep` | 30-day retention sweep, restore, empty/loading/busy/error. | `List`/`VirtualList`, `Button`, `Alert`, confirmation `Dialog`. |
| `NotesView`, `FolderTile`, `NoteCard`, `NoteThumb` | Vault empty state and folder picker, note board/cards, source kind marks, thumbnails, folder move/recolor/rename, open note, loading/error. | `VirtualList`/grid, `Image`, `Dialog`, `Popover`, `Select`/`ColorPicker`; preserve vault path containment and thumbnails. |
| `GoalCard`, `GoalView`, `GoalLedger`, `GoalPlan`, `GoalAgents` in `desktop/src/goal.tsx` | Status active/complete/blocked/budgetLimited/usageLimited, progress bar, objective, budget/tokens/time, blocker, revision history, plan, agents, open thread, pause/resume/continue/clear. | `Card`/styled `GroupBox`, `Badge`, `Progress`, `DescriptionList`, `Tree`, `VirtualList`, confirmation `Dialog`; keep exact status colors and tabular counts. |

### Knowledge, artifacts, previews, dynamic components

| Surface | State and interaction | GPUI target |
| --- | --- | --- |
| `ArtifactsView`, `ArtifactCard`, `ArtifactFrame`, `ArtifactRender` in `desktop/src/artifacts.tsx` | Grid/list toggle; filters and no-match; lazy/eager preview via `IntersectionObserver`; source vs render; HTML/Markdown/Mermaid/SVG/React/code; iframe sandbox; artifact SQL bridge; edit/delete; destructive confirm; missing/corrupt/error/empty. | `VirtualList`/grid, `Dialog`, `AlertDialog`, `TextView`/custom markdown, syntax `Editor`, image/SVG/native web surface only behind a capability boundary. Preserve artifact origin, sandbox CSP, SQL one-statement rule, frame message protocol, and path limits. |
| `MermaidArtifact` in `desktop/src/mermaid-artifact.tsx` | Lazy Mermaid load, strict security, render failure, source fallback. | Rust Mermaid/SVG renderer or isolated web view; never make dynamic diagram input trusted GPUI markup. |
| `ReadMarkdown`, `PreviewHost`, `Body` in `desktop/src/preview.tsx` | Async folder read, text/image/source/render modes, Open In, reveal in Finder/File Explorer, missing/error/too-large/non-text. | `TextView`/`Editor`, `Image`, `Dialog`, host action bridge; preserve async cancellation and path authorization. |
| `Visual` in `desktop/src/visual.tsx` | Sandboxed `iframe` visual, async read/missing, dynamic height postMessage, point selection, edit/draw selection, export PNG, keep as artifact, notes/errors. Defaults 720 px wide, 120–760 px high. | Native GPU chart/canvas where possible; otherwise isolated web surface with equivalent origin and message policy; `Dialog`, `Button`, `Popover`; preserve selection coordinates and artifact promotion. |
| `Region`, `RegionBoundary`, `runtime` in `desktop/src/regions.tsx` | Artifact-supplied regions dynamically mount into navbar/chat/context; one module per region; runtime errors isolate to fallback; portal to host zones. | Explicit capability-scoped extension host. Use `gpui-shell` only if its sandbox and lifecycle can match; otherwise defer parity instead of embedding arbitrary code. Stable region IDs and boundary fallbacks are required. |
| `Built`, `Mounted`, `Frame`, `Reveal`, `BuiltMenu`, `BuiltSettings`, `Variables` in `desktop/src/components.tsx` | Component catalog loading, animated character reveal (720 ms), full-screen dialog (1280×840), attach to thread, enable/expand/delete, screenshots, variables validation/save/clear, errors. | `List`/`VirtualList`, `Dialog`, `Menu`, `Input`/`Textarea`, `Progress`/custom reveal animation with reduced-motion branch; same capability sandbox and iframe frame protocol. |

### Browser and terminal

| Surface | State and interaction | GPUI target |
| --- | --- | --- |
| `BrowserPane` and `browserPip` in `desktop/src/browser.tsx` | Tab strip, title/favicon/loading, select/close/new tab, back/forward/reload, address Enter/Esc, clipboard/history clips, float/wide/hide/close, blank new tab, hidden when buried/dialog/zero. Placement coalesces `ResizeObserver`/`MutationObserver`/transition-frame signals. | Native webview/webview host with explicit navigation and permission boundary; `Tabs`, `Input`, `Button`, `Popover`, `Menu`, `Resizable`, `Dialog`/PIP. Preserve attach authorization, active tab, placement scheduler, and cleanup. |
| `PipLayer`, `PipMenu` in `desktop/src/pip.tsx` | PIP default 384×300, min 320×260, edge 12, stack 18, depth 3, rail 36; coverage sample 5×4; avoid composer/ink; tear threshold 5; front/hidden rail; drag/resize/collapse; keyboard arrow resize; outside/Esc menus; status tone. | GPUI child windows or retained overlay entities with native hit-testing and focus scopes; custom placement solver ported verbatim. Validate geometry with screenshots at multiple window sizes. |
| `TerminalPanel`, `TerminalSurface`, implementation in `desktop/src/terminal*.tsx` | Lazy xterm load; shell auto-start; tabs select/pop/close/new/hide; link context menu (Emma/system browser); output/error/empty; fit/resize and 80 ms settle; link modifier Cmd/Ctrl; selection-to-composer; active focus/cursor; data/read/write/resize/replay; stale tab/response rejection. | Native PTY entity plus GPUI text/editor surface or isolated terminal renderer. `Tabs`, `Menu`, `Resizable`, `Scroll`/virtualized output; preserve terminal selection budgets and replay semantics. |

### Agents, context, CLI, monitoring

| Surface | State and interaction | GPUI target |
| --- | --- | --- |
| `agents.tsx`: `ModeTrigger`, `ModeMenu`, `ModePicker`, `PermissionPrompt`, `AgentRail`, `BackgroundRail`, `AgentPanel`, `ThreadCard`, `SubagentChips`, `ChangesPanel` | Permission mode listbox; arrows/Home/End/typeahead/Esc/Tab/outside/focus; allow once/turn/deny/Escape; recursive live/background agents; stop/steer/open; changes diff/revert/open/read; collapse chips; polling and external permission store. | `Select`/`Combobox`, `Dialog`/`Alert`, `Tree`, `VirtualList`, `Tabs`, `Progress`, `Editor`/diff view, typed subscription entities. Every permission request must be fail-closed and keyboard reachable. |
| `context-bar.tsx`: `ContextBar`, widgets, `ContextBarSettings`, `PlacedWidget` | Vertical/horizontal context bar; stats/context ledger/timeline/task list/plan/subagents/machine/subthreads/git; reorder/add/remove; metric picker; agents rail; subthread actions; max context pages; settings page create/delete/rename/drag palette/workbench preview/inert fixture. | `Sidebar`/`DockArea` or custom bar, `Resizable`, `VirtualList`, `Dialog`, `Menu`, typed drag/drop. Preserve widget IDs/order/orientation and individual viewport scroll handles. |
| `cli.tsx`: `CliPanel`, status/stream blocks, composer, `CliStats` | Run output tail-follow scroll; Markdown/raw stream; dynamic model picker/refresh; attachment/send/error; float/stop/next-turn/raw; loading/empty/error. | `MessageScroller`, `TextView`, `Textarea`, `Select`, `Popover`, `Button`, `Alert`. Hold poll tasks and stop tokens in entities. |
| `machine.tsx`: `MachineStats`, `MachineGraph`, `MachineMeters` | Samples every `MACHINE_TICK_MS` only while visible; CPU/memory/GPU/network series; graph and 16-cell meters; empty “Reading this computer…”. | `Chart`/`Plot`, `Progress`, custom meter; subscribe/unsubscribe on visibility and preserve reduced-motion behavior. |
| `harness.tsx`: `HarnessStatus` | Health button, 10 s poll, log flow filters all/out/in/err, details, restart, copy fix prompt, loading/empty/error. | `StatusBar`/`Badge`, `Dialog`, `Tabs`, `List`, `Button`, `TextView`, `Alert`. |
| `ActivityView.tsx` | Activity metrics, heat calendar week/year/all-time dialog, thread bars, project sparks, lineage tree, empty. | `Calendar`/custom heatmap, `Chart`, `Tree`, `Dialog`, `VirtualList`, exact 10 px cells and chronology. |
| `AgentView.tsx` | Activity/Self improvement/Worktrees tabs; Memories dialog; traces/friction/trial comparison/revert; bench proposal flow and evidence/retry/propose/handoff; decisions keep/retest/stop; loading/empty/error. | `Tabs`, `Dialog`, `Tree`, `Chart`, `DataTable`, `Progress`, `Alert`, nested entity state; preserve trial arm and evidence transitions. |
| `BenchPanel.tsx` | Save/remove prompts as cases, baseline/trial run, progress/stats, metric selector, blockers, paired results/verdict/attempts/deltas/curve, empty/no folders/disabled/error. | `Form`, `List`, `Chart`, `DataTable`, `Progress`, `AlertDialog`, `Button`; runs are async tasks with cancellation and immutable run identity. |
| `WorktreesView.tsx` | Folder select/load/error, persisted branch prefix, create worktree, search/filter/select all/clear, primary/prunable/locked/bare/detached/dirty/clean badges, removal confirmation, empty/loading. | `Select`, `Input`, `List`/`VirtualList`, `Badge`, `Checkbox`, `Dialog`, `Alert`. |

### Git, research, plans, tasks, traces, markdown

| Surface | State and interaction | GPUI target |
| --- | --- | --- |
| `git.tsx`: `GitSetup`, `GitPanel`, `GitPage`, `FileMark` | No Git/no repo/init setup; compact diff; truncation/open full; branch picker/new branch; ahead/behind/worktree/head; include/exclude/filter/status; open/attach/read Markdown; history graph/pagination; commit/amend/model message; Changes/Console tabs; command parser/error; selection-to-composer. | `DataTable`/`VirtualList`, `Tree`, `Editor`/diff, `Tabs`, `Select`, `Input`, `Textarea`, `Checkbox`, `Dialog`, `Menu`, `Pagination`; retain filetype assets and command validation. |
| `research.tsx`: cards/detail/form/graph | List/new/detail; running/paused/finished/failed; start/pause; metric grep/judge; project/eval/model/prompt/rubric/permission/budgets; frozen fields after save; counters/table/edit/delete; Recharts graph tooltip baseline/now; empty/no-run/error. | `Form`, `Select`, `Textarea`, `NumberInput`, `Chart`/`Plot`, `DataTable`, `Progress`, `Dialog`, `Alert`; preserve metric direction and budget exhaustion semantics. |
| `plan.tsx`: `PlanGraph`, `PlanRail`, `PlanFile`, `PlanEntry`, `PlanTasks` | Graph/waves/edges/status keys; selection; current-agent tabs; task pagination 6; empty; modal scroll/focus. | Custom graph plus `Tabs`, `Tree`/`VirtualList`, `Dialog`, `Progress`; use `placeRows`/`edgePath` and preserve keyboard/pointer selection. |
| `task-list.tsx`: `TaskListRail`, file modal, entries | Rail/file modal; task selection; graph/progress/key/status/details/Markdown; empty; split map/document; keyboard/pointer graph. | `Tree`, `VirtualList`, `Dialog`, `TextView`, custom graph overlay. |
| `timeline.tsx`: `Timeline`, `TimelineDialog`, `Rows`, `TimelineAxis`, `SpanDetail` | Read-only live/trace waterfall; collapsed tree/span detail; time/context axis; expanded stats/tool duration/legend/axis; no-data state; open spans tick every 500 ms. | `Chart`/`Plot` or custom GPU waterfall, `Tree`, `Dialog`, `DescriptionList`, `Legend`; ensure updates do not steal focus or reset collapse/selection. |
| `run-block.tsx`: `CodeBlock` | Shell-only Markdown code block, run/copy, background polling every 600 ms, stop/output/add-to-chat, errors; `RunContext` folder boundary. | `Editor`/syntax text, `Button`, `Progress`, `TextView`, `Popover`; preserve shell allowlist and context cap. |
| `markdown.tsx`, `markdown-parse.ts` | No `innerHTML`; headings demoted; inline code/emphasis/link/image; lists/tables/quotes/rules; safe file paths; run buttons; copy; links; image previews; language highlighting. | `TextView` or application parser/render tree. Keep safe URL/path policy, code-run boundary, selection/copy, and table horizontal scrolling. |

### Settings, setup, models, providers, imports, mobile

`SettingsPage` in `desktop/src/App.tsx` is the union: `keybinds`, `notch`, `voice`, `appearance`, `contextbar`, `models`, `prompts`, `tools`, `permissions`, `harness`, `imports`, `mobile`, `built`, `privacy`, `about`. `SettingsNavigation` groups pages under Personal, Coding, Integrations, and Emma. `SettingsView`/`SettingsBody` preserve save/rollback, busy disabling, error reporting, provider registration rollback, zero-retention, reset-data, and settings synchronization.

| Surface | State and interaction | GPUI target |
| --- | --- | --- |
| `SettingsNavigation`, `SettingsView`, `SettingsBody` | Two-column settings shell; page selection; busy/error; persisted appearance/context pages/models/prompts/tools/permissions/harness/import/mobile/built/privacy/about. | `Settings`/`Sidebar`, `List`, `Scroll`, `Form`, `Alert`, `Notification`; exact 184 px navigation and 720 px content behavior. |
| `KeybindSettings` | Global keydown/keyup capture; hold modifiers; Escape cancel; conflict/problem/refused states; clear; hold durations; native shortcut sync. | `Form`, `Input`, `Select`, `Alert`; app-level key dispatch, focus scope, and native global shortcut bridge. |
| `VoiceSettings` | Microphone status/privacy; SAPI/mac speech/server setup/check/retry; hold-to-talk; test; disabled/provider errors. | `Form`, `Select`, `Input`, `Button`, `Alert`, `StatusBar`; native audio permission boundary. |
| `NotchSettings` | Overlay model and concurrency; lessons/orb order/position. | `Form`, `Select`, `Slider`, `List` reorder, preview `GroupBox`; persist exact overlay settings. |
| Appearance/context settings | Accent swatches/custom HSV color; scale; content width; navigation colors/hues/fonts; context pages metrics/widgets/orientation/max pages and reset. | `ColorPicker`, `Slider`, `Select`, `Tabs`, `List`/drag reorder, preview; map CSS tokens to GPUI theme values. |
| `ModelCatalog`, `ModelPicker`, `ModelMenu`, `RouterEditor`, `ProviderSettings`, `ProviderKeys`, `ModelPlans` | Catalog loading/stale/error; provider/API-key/subscription rows; masked credentials; spend 5 h/7 d and DeepSeek balance; local provider test/add/remove/use; model search/filter/star/reorder; routers; free-only; pinned model; CLI plan sign-in terminal. | `List`/`VirtualList`, `Combobox`, `Select`, `Input`, `Password`/masked input, `Button`, `Tabs`, `Dialog`, `DataTable`, `Drag` reorder, `Alert`; keep catalog route/provider identity and secret redaction. |
| `PromptEditor`, `ScopePicker`, `SecondModelPicker` | Global/conditional prompts, variable token insertion, scopes by all/family/model, fork/delete/reset, model route selection, character bounds. | `Editor`/`Textarea`, `Popover`, `Combobox`, `Tag`, `Button`; preserve caret insertion and model-family routing. |
| `VerifierPanel`, `AdvisorPanel`, `SecretPanel`, `VisionPanel`, `WebSearchPanel` | System prompt limits and reset; custom/catalog model; provider chains; keyed web search fallback; request/command/output/image privacy copy; save/rollback/errors. | `Form`, `Textarea`, `Select`, `Combobox`, `Alert`, `Dialog`; preserve exact privacy warnings and fail-closed route validation. |
| `ToolSettingsPanel`, `HarnessExperimentsPanel` | Built/imported tool/skill/MCP toggles; default permission mode; experiment enable/steps/percent/suggestion; web-search providers and limits; disabled/busy. | `Switch`, `Slider`, `NumberInput`, `List`, `Alert`; controlled state callbacks and persisted settings. |
| `AgentImports`, `ImportDialog` | Scan Codex/Claude/Antigravity/Pi/OpenCode/Cursor/Windsurf/Devin; selectable sources; unavailable/no files; scanning/error; references-not-copies; later/close. | `Dialog`, `Checkbox`, `List`, `Button`, `Alert`, brand `Image`; preserve source counts and no accidental activation. |
| `PermissionSettings`, setup permissions | Grant/review/not-required/unknown states; open native pane; tools link; status updates. | `List`, `Badge`, `Button`, `Alert`; native permission bridge and stale state handling. |
| `SetupDialog` | Six steps Emma/Model/Quick Ask/Permissions/Knowledge/Agents; skip/back/continue/start; vault selection, write readiness, OpenRouter key/balance/model menu, demo quick ask, import scan, lessons. | Focus-trapped `Dialog`/`Stepper`, `Form`, `Select`, `Button`, `Alert`; persist setup-seen and do not dismiss on accidental outside click. |
| `MobileSettings` in `desktop/src/mobile.tsx` | Pair/unpair status; PIN 4–12 digits; QR expires in 2 minutes; Tailscale/Wi-Fi address; max 3 devices; error/confirm/cancel and cleanup. | `Dialog`/`Sheet`, `OtpInput` or bounded `Input`, `Image`/QR renderer, `List`, `Alert`; never display or persist the PIN in QR payload. |
| `built` settings | Built component catalog, screenshots, install/enable/expand/delete, variables. | Same component-host requirements as `components.tsx`; `Dialog`, `List`, `Input`, `Button`, `Alert`. |
| privacy/about | Retention/reset confirmation, local/provider privacy prose, credits/asset licenses/version/update. | `TextView`, `Dialog`, `AlertDialog`, `Button`, links with external URL policy. |

### Overlay and quick-ask matrix (`desktop/src/App.tsx`, `desktop/src/styles/overlay.css`)

`Overlay` is a separate window/surface, not a modal inside the workspace. Preserve these constants and transitions: `ISLAND_BOTTOM=97`, `ORB_DROP=105`, `MAX_TRANSCRIPT=260`, `MIGRATE_AFTER=6`, `POPOUT_BAR=28`, `PILL_LINGER_MS=2400`, `PILL_FADE_MS=320`, `SETTLE_MS=700`, `WAVE_ROWS=2`, `ATTACHMENT_BAND=60`.

- `NotchWave`: busy/idle waveform with reduced-motion branch.
- `OrbRing`/`RadialCommands`: quick actions around the notch, selection and keyboard/pointer dispatch.
- `NotchHotspot`: hover-open hotspot and 260 ms delayed close.
- `StatusPill`: working/error/done status, pointer drag, auto fade/dismiss.
- `Overlay`: local draft persistence, quick turns and live delta/steps, model and permission mode menus, slash/@ completion with IME guard and arrows/Enter/Tab/Esc, Enter send and Shift newline, Escape menu dismiss, annotation thumbnail/discard, voice space-hold, Cmd/Ctrl+1..3 quick actions, resize observer height, detach/popout, busy/error/done, migration after six turns.
- `ScreenAnnotation`: drawing toolbar/canvas, yellow pen, pointer coordinates, screen capture/app context, save/clear.
- `ComputerRunBanner`/`ComputerActivityCursor`: progress/target-relative cursor, readiness, invalidation, expiry, abort, reduced motion.

GPUI requirements: separate native borderless windows where the Electron app uses separate query windows; transparent/always-on-top/level/position must match; use focus scopes and explicit focus restore; preserve outside click/Escape ordering; use a retained `Entity` for draft/live stream; schedule animation only while visible and respect reduced motion/transparency/increased-contrast settings.

## Design tokens and styles

The CSS files are not optional decoration. Port their resolved values into a GPUI theme and retain the class-to-surface mapping until screenshot parity is proven.

| CSS file | Contract to carry into GPUI |
| --- | --- |
| `desktop/src/styles/tokens.css` | Dark semantic palette: `--bg #0e0e10`, `--surface #131316`, `--surface-2 #17171a`, `--surface-3 #1c1c20`, `--surface-4 #232327`, text/border opacity variants, rose/orange/lime/yellow/teal/blue/violet palette, orange accent/danger/solid colors, zero/full radii, spacing 4/6/8/12/16/20/24/32 px, font sizes 10/11/12/13/14/15/17/20 px, Inter/Departure Mono/code fonts, shadows, 120 ms ease, content gutter clamp 12–28 px, 720 px content column, 72 ch prose, 1080 px/96 ch conversation max. |
| `index.css` | Root/reset, 100% viewport, overflow hidden, inherited controls, disabled opacity, accent focus ring, custom checkbox/range, scrollbars, screen-reader-only/skip-link, Emma bitmap/brand, reduced motion. |
| `sidebar.css` | Sidebar grid/rail; 28 px rows, 12 px pad, 46 px top/drag region; glass chrome; collapsed zero-width plus 8 px reveal; nav 3-column glyph/text/count and 34 px icon mode; project/thread depth/tag/status animations; 228/200 px menus; 30 px search; footer; scheduled max 40%; resize handle. |
| `conversation.css` | Thread grid columns and terminal row; 46 px thread bar; panel toggles; transcript/rail/welcome; message/user widths; markdown/prose/code; thought details; visual cards; step status animation; loading/stalled/context/rules/meta; composer/chips/textarea/slash menu/source/model menus/34 px model rail/capability panels/thinking slider/queue/attachments/tiles/toasts/quote menu. |
| `browser.css`, `terminal.css` | Browser 38 px tab strip, 200 px max tabs, 26 px controls, 30 px address; clips max 38%; terminal 30 px tabs/stage/link menu/empty/error; PIP overrides. |
| `artifacts.css`, `built.css`, `markdown.css` | Artifact grid/list/card min 280 px, 640 px frame, 190 px clip, 900 px dialog, confirm/errors; built 720 ms reveal, 1280×840 dialog, 132×88 cards, variables; markdown table/fence/run/path/image/preview/code/highlighting. |
| `context-bar.css`, `panels.css` | Context orientation and widget layout; DnD grips; machine graph/meters; shared controls/buttons/inspectors/ledger/empty; agent/scheduled/tasks pages; workflow node 190×76 and graph; page/notice/modal dimensions; knowledge board five columns min 232 px; responsive breakpoints. |
| `git.css`, `research.css`, `activity.css`, `worktrees.css`, `goal.css` | Git 340 px side/diff/history/console and <=900 px collapse; research graph/form/outcomes/frozen fields; activity 10 px heat cells and chart/dialog; worktree list/badges/sticky footer; goal statuses/progress/ledger/revisions. |
| `plugins.css`, `settings.css` | Plugin catalog min 260 px grid/cards/dialogs/marketplaces/hooks/skills graph; settings 184 px side/720 px content, controls, prompts/scopes/keybinds/orbs/catalog/providers/import/setup six-step/model picker/tools/harness, <=900/760 responsive behavior. |
| `overlay.css`, `timeline.css`, `color-picker.css` | Notch/island/popout geometry, status pill/radial/orbs/wave/annotation/run/cursor; inline 210–360 px and dialog 1080 px trace waterfall; 212 px color popover, 132 px SV field, 12 px hue bar, hex row. |
| `agents.css` | Agent rail/panel/permission prompt/background rail, changes/diff, recursive chips, statuses, and PIP/subagent styling. |

Use a semantic theme record rather than scattering literals. Appearance settings must update the theme live and persist exactly as today. GPUI text layout must load `desktop/assets/DepartureMono-Regular.woff2` and preserve the Inter/system fallback behavior. Verify dark contrast, focus-visible, reduced motion, increased contrast, transparency, and VoiceOver labels.

## Assets and icon parity

All current assets are local and must remain local/bundled in the GPUI target:

- `desktop/assets/emma.webp`, `emma-blink.webp`, `emma-dock.png`, `emma.icns`, `emma.icon/Assets/bow.svg`, `emma.icon/icon.json`.
- `desktop/assets/DepartureMono-Regular.woff2` and `DepartureMono-LICENSE.txt`.
- Brand assets in `desktop/assets/brands/`: `anthropic.svg`, `antigravity.png`, `bytedance.svg`, `claude.svg`, `cohere.svg`, `cursor.svg`, `deepseek.svg`, `ernie.svg`, `gemini.png`, `github.svg`, `gitlab.svg`, `hunyuan.svg`, `jira.svg`, `kimi.svg`, `liquid.svg`, `meta.svg`, `minimax.svg`, `mistralai.svg`, `naver.svg`, `nvidia.svg`, `obsidian.svg`, `openai.svg`, `opencode.svg`, `openrouter.svg`, `pi.svg`, `poolside.svg`, `qwen.svg`, `sakana.png`, `thinkingmachines.svg`, `todoist.svg`, `windsurf.svg`, `xai.svg`, `xiaomi.svg`, `zai.svg`, with definitions and aliases in `desktop/src/brands.ts` and `desktop/src/brand-data.ts`.
- Filetype assets in `desktop/assets/filetypes/`: archive, astro, audio, binary, C, Clojure, CoffeeScript, config, C++, Crystal, C#, CSS, Dart, DB, document, Docker, Elixir, Erlang, font, Fortran, F#, Git, Go, Gradle, GraphQL, Groovy, Haskell, HTML, image, Java, JavaScript, Julia, Kubernetes, Kotlin, Less, lock, Lua, Markdown, nginx, Nim, OCaml, Perl, PHP, Python, R, Racket, React, Ruby, Rust, Sass, Scala, shell, Solidity, SQLite, Svelte, SVG, Swift, Terraform, TeX, TOML, TypeScript, video, Vim, Vue, WASM, XML, YAML, Zig.
- Inline SVG icon implementations in `desktop/src/icons.tsx`: Emma mark/blink, Mark, InfoDot, BrandIcon, Expand, Caret, Trash, Clip, Globe, Tool, Tab, Stop, Fold, Dock, Close, Gear, More, Search, Text, Sidebar, Branch, Pin, Chevron, Book, Glass, Tree, Move, Spark; additional inline marks live in `desktop/src/App.tsx`, `desktop/src/browser.tsx`, `desktop/src/run-block.tsx`, and `desktop/src/git.tsx`.

GPUI icon policy: use `gpui_component::Icon` only with equivalent bundled paths; do not substitute a different icon set or fetch icons. SVG/PNG/WebP decoding must preserve intrinsic size, opacity, alt/VoiceOver semantics, and dark-theme colors.

## State, bridge, and async requirements

- `desktop/src/types.ts` is the renderer data contract: threads/messages/goals/scheduled jobs/research iterations/jobs/snapshots, models/catalog/routes, imported skills/MCP/tools, browser tabs/status, plugins, credentials, mobile/voice/terminal/trace/vault types.
- `desktop/src/runs.ts` owns live turns: queue/held turns, foreign runs, blocks, landed/cached blocks, stale generation protection, rehydration from spans/partials, stop/release/settle, delta/step/compaction/experiment/routed-model events. GPUI must use entity observation/subscriptions and retain Tasks; it must not poll from `render` or lose a streaming block on view changes.
- `desktop/src/context.ts` owns local persisted drafts, folders, modes, attachments, cached blocks, context-use/breakdown, clear markers, ledger, and turn attachment matching. Keep one source of truth per thread and preserve storage size/eviction behavior.
- `desktop/src/boot.ts` prefetches compact summaries only for workspace windows. GPUI startup should retain the same fast summary-first behavior and target-specific thread loading.
- Every `window.emma.*` call in the renderer needs a typed Rust host request/event equivalent. Preserve error strings, cancellation, request ownership, and no-late-result rules before replacing UI.
- Native boundaries include filesystem/folder grants, artifact/component frames and SQL, browser attachment, terminal PTY, Git, machine probe, mobile pairing, permissions, screen capture/computer control, voice, secrets, model/provider/catalog, harness health, and update status. These are not visual-only ports.

## Existing tests to carry into GPUI acceptance

The tests are mostly pure boundary/state tests rather than DOM tests, so retain their assertions while adding GPUI interaction/screenshot tests for each slice.

| UI area | Existing tests |
| --- | --- |
| Workspace/thread/sidebar/routing/layout/panes | `desktop/test/threads.test.ts`, `thread-state.test.ts`, `nav-order.test.ts`, `panes.test.ts`, `dates.test.ts`, `runs.test.ts`, `run-settlement.test.ts`, `turn-admission.test.ts`, `turn-attachments.test.ts`, `composer-draft.test.ts`, `composer-history.test.ts`, `composer-ime.test.ts`, `composer-send.test.ts`, `slash.test.ts`, `thinking.test.ts`, `thread-namer.test.ts`, `context-clear.test.ts`, `ledger.test.ts`, `model-switch.test.ts`. |
| Transcript/tools/Markdown/visuals | `markdown.test.ts`, `highlight.test.ts`, `trace.test.ts`, `visualize.test.ts`, `computer-cursor.test.ts`, `computer.test.ts`, `optional-arguments.test.ts`, `invocations.test.ts`, `verifier.test.ts`, `vision.test.ts`, `secret.test.ts`. |
| Artifacts/components/previews/attachments | `artifacts.test.ts`, `artifact-grid.test.ts`, `components.test.ts`, `frames.test.ts`, `attachments.test.ts`, `attachment-image.test.ts`, `clip.test.ts`. |
| Browser/terminal/CLI/harness | `browser-attach.test.ts`, `browser-layout.test.ts`, `terminal.test.ts`, `cli.test.ts`, `background.test.ts`, `background-rail.test.ts`, `harness.test.ts`, `harness-edits.test.ts`, `host-framing.test.ts`. |
| Agents/permissions/goals/plans/tasks | `agent.test.ts`, `permission.test.ts`, `permission-listeners.test.ts`, `runtime-cancellation.test.ts`, `goal.test.ts`, `plan.test.ts`, `task-list.test.ts`, `bench-boundary.test.ts`, `bench-kin.test.ts`, `bench.test.ts`, `improvement.test.ts`, `memory.test.ts`. |
| Schedule/workflow/research | `trigger-picker.test.ts`, `schedule-ipc.test.ts`, `workflow.test.ts`, `workflow-script.test.ts`, `research.test.ts`. |
| Settings/models/providers/tools/imports/voice/mobile/vault | `catalog.test.ts`, `model-metadata.test.ts`, `model-plans.test.ts`, `model-switch.test.ts`, `provider-onboarding.test.ts`, `capabilities.test.ts`, `system-prompt.test.ts`, `setup.test.ts`, `pairing.test.ts`, `bridge.test.ts`, `mobile.test.ts`, `tailnet.test.ts`, `web-search.test.ts`, `web.test.ts`, `vault.test.ts`, `folders.test.ts`, `color.test.ts`, `editors.test.ts`. |
| Activity/machine/worktrees/update/platform | `activity.test.ts`, `machine.test.ts`, `worktrees` behavior is covered through Git/shared tests and needs new UI tests, `update.test.ts`, `windows.test.mjs`, `conversation-css.test.mjs`. |

Add GPUI-side tests at the same seams: key dispatch/listbox traversal; focus trap and restore; outside click/Escape ordering; text selection/IME/clipboard; drag/drop keyboard fallback; virtual-list scroll anchoring; modal and PIP placement; async cancellation/stale response; accessibility tree names/roles/states; reduced-motion/contrast; screenshot dimensions and pixel/color diffs.

## Prioritized implementation slicing plan

1. **Native shell and bridge contract.** Add the Rust GPUI binary/window lifecycle, theme initialization, typed request/event bridge, startup summary loading, native assets/fonts, and a parity test harness. Freeze the `desktop/src/types.ts`/host contracts before UI translation.
2. **Theme, primitives, and workspace geometry.** Port `tokens.css`, root focus/scroll rules, `layout.ts` validation, sidebar, navigation, resizable inspector/browser/terminal docks, menus, dialogs, toasts, and responsive breakpoints. Verify the empty workspace and screenshot geometry before data-rich screens.
3. **Thread transcript and composer.** Port `runs.ts`/`context.ts` state adapters, virtualized transcript, Markdown, tool/thinking/edit blocks, context ledger, queued sends, slash/@ completion, attachments, model/mode pickers, quote, and keyboard/IME behavior. This is the highest fan-out slice and gates most other screens.
4. **Inspector widgets and agent surfaces.** Port agents/permissions, context bar, task list, plan, timeline, machine, Git panel, CLI, and subthread panels. Use virtual lists and entity-backed subscriptions; add interaction tests for every collapse, tab, stop, steer, and selection path.
5. **Workspace pages.** Port knowledge/vault, artifacts/previews/visuals, scheduled workflows, archive, goals, research, activity, worktrees, and Git full page. Preserve graph geometry and empty/loading/error/disabled states before styling polish.
6. **Settings/setup/provider catalog.** Port all 15 settings pages, six-step setup, import flow, model/provider/catalog/router/prompt/tools/harness/privacy/about/mobile/voice/keybind flows. Include persistence/rollback and native permission tests.
7. **Browser/terminal and dynamic surfaces.** Port native webview/browser PIP and PTY terminal with their security boundaries, then built components/artifact regions/visual iframe/SQL/Mermaid. These are the highest-risk non-GPUI surfaces and need explicit capability audits.
8. **Overlay windows and computer/voice workflows.** Port hotspot/radial/notch/quick ask/pill/popout, annotation, cursor/run banners, dictation, screen capture, and model/action menus. Validate always-on-top, transparency, display geometry, global shortcuts, reduced motion, and focus restoration on macOS.
9. **Parity hardening.** Run the complete existing test suite plus GPUI interaction tests; compare screenshots at default/min/max/sidebar-collapsed/browser-wide/terminal-open/PIP/overlay states; verify VoiceOver, contrast, scaling, display changes, long transcripts/lists, cancellation, persistence migration, packaging/signing, and Windows/Linux declared support. No slice is complete while a fallback Electron renderer silently handles an unported screen.

## Definition of done for each slice

- Every route/component in the slice has a GPUI owner and a typed state source.
- Loading, empty, error, disabled, stale, busy, stopped, cancelled, and permission-denied states are represented explicitly.
- Pointer, keyboard, IME, clipboard, drag/drop, focus, Escape/outside dismissal, and focus restoration match the Electron behavior.
- Dimensions, colors, typography, spacing, animation timing, asset identity, and responsive behavior match the relevant CSS and screenshot baseline.
- Existing pure tests remain green and new GPUI tests cover the interaction and async boundary.
- The real native app has been launched and the changed interaction exercised on every claimed platform; unverified permissions, VoiceOver, display geometry, signing, and non-macOS paths remain explicitly reported.
