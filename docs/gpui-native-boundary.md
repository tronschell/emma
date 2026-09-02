# GPUI native boundary

This is the local migration map for the `gpui` branch. It is an inventory of
the Electron implementation, not a claim that the native application is
complete. The current workspace has no GPUI crate. `Cargo.toml` contains only
`crates/core` and `crates/host`; the Electron application is still the only
desktop UI.

The parity requirement has two separate parts:

1. GPUI must reproduce the visible surfaces and interaction semantics in
   `desktop/src`.
2. The trusted desktop owner must reproduce every capability currently owned
   by `desktop/main`.

Porting only the React views satisfies neither requirement. The renderer is a
presentation layer over 207 callable `window.emma` members, 35 of which are
event subscriptions, plus the `platform` value. `desktop/main/main.ts`
registers 172 unique `emma:*` IPC channels. Its process also owns model
selection, the agent loop, native helpers, browser and terminal lifetimes,
permission routing, and all privileged file and network work.

## Target process boundary

The smallest safe native shape is:

```text
GPUI application
  ├─ native platform adapter
  ├─ emma-host child: emma-core records and scheduled/research stores
  └─ emma-cli child: existing Zig ACP harness and its tools/providers/MCP
```

The GPUI process replaces Electron main and the sandboxed renderer together.
It owns the application windows, typed actions, view state, focus, input,
permission surfaces, and orchestration. `emma-host` remains a separate child
at first so the existing NDJSON boundary and atomic Markdown persistence stay
intact. `emma-cli` remains a separate child so the existing ACP agent,
subagents, skills, MCP, and provider behavior can be exercised unchanged.

This is the minimum boundary that still has a single trusted desktop owner.
Keeping `desktop/main` alive as a hidden Electron application would not be a
move off Electron: it would leave the old window manager, IPC trust boundary,
and native capability owner in the product. A temporary non-Electron service
may be used while a subsystem is being ported, but it must not import Electron
or own a window.

The native process must preserve these invariants:

- every external request is shape-checked before it reaches a store, helper,
  plugin, web view, child process, or model;
- permission mode and `toolGate` remain one decision point for composer,
  Quick Ask, shortcut actions, scheduled jobs, mobile, and agent calls;
- the stop switch cancels the active turn and helper processes, and a denied or
  unanswered permission is a denial;
- only one process writes the Emma data root at a time;
- model/provider calls remain outside `emma-host` and are driven by the app;
- credentials never cross into a view or get written as plaintext;
- large protocol lines, chunked host responses, ACP updates, and EOF/error
  behavior retain their current limits.

## Reuse map

| Existing area | Reuse in GPUI migration | Work still required |
| --- | --- | --- |
| `crates/core/src/lib.rs` | Reuse the crate and its public record types | None for the first boundary. Add native-facing adapters only when a real second implementation needs them. |
| `crates/core/src/live.rs` | Reuse `LiveClient`, `LiveSnapshot`, runtime commands, and due-job sink | Map native app events to the existing client; do not move model calls into core. |
| `crates/core/src/thread.rs` | Reuse IDs, message/thread schemas, validation, limits, and atomic Markdown writes | Port any renderer-only formatting separately; the record format is the compatibility contract. |
| `crates/core/src/record.rs`, `scheduled.rs`, `research.rs` | Reuse stores, parsers, validation, and atomic persistence | Native scheduled/research UI must call the same methods and retain status/iteration semantics. |
| `crates/host/src/main.rs` | Reuse the NDJSON protocol and host binary | Build a native client for 128 KiB requests, 64 KiB response frames, unsolicited `dueJob`, `deny_unknown_fields`, and error/EOF behavior. |
| `crates/host/src/runtime.rs` | Reuse data-root resolution and `EMMA_DATA_DIR` behavior | Native app must select the same default root and single-writer lifecycle. |
| `harness/src/main.zig` and `harness/src/acp/*` | Reuse `emma-cli` as a child over ACP | Port `desktop/main/harness.ts`'s ACP client/session orchestration to Rust or another non-Electron owner. |
| `desktop/native/pty.c`, `pty_win.c` | Reuse the helper and its self-test | Replace xterm.js with a GPUI terminal parser/renderer or a native terminal component; keep PTY framing and resize semantics. |
| `desktop/native/quick_ask.m`, `quick_ask_win.cpp` | Reuse helper protocol and self-tests | Replace Electron panel/windows/global shortcut wiring with native windows and event handling. |
| `desktop/native/computer.m`, `computer_win.cpp` | Reuse helper protocol and self-tests | Replace run-banner/cursor windows and permission routing; verify Accessibility/UI Automation grants. |
| `desktop/native/transcribe.m`, `transcribe_win.cpp` | Reuse helper protocol and self-tests | Native process must launch it, request microphone permission, and keep the same input/output/error contract. |
| `desktop/src` pure data/format logic | Port the algorithms and preserve fixtures/contracts | TypeScript cannot execute inside GPUI. Do not silently reimplement caps, sorting, Markdown, or geometry with different behavior. |
| `desktop/src` JSX/CSS | Use as visual and interaction specification | Rebuild every surface in GPUI; CSS, DOM, React state, and browser APIs are not directly reusable. |

The existing Rust and Zig code is the highest-value reuse. A first native
implementation should not rewrite the harness or durable record layer while
the UI boundary is being proven.

## Renderer API inventory

The following is the complete `window.emma` inventory from
`desktop/main/preload.ts`. Counts are callable members only; `platform` is an
additional read-only value. Every entry needs a native command, an app event,
or an explicitly native-only replacement. Names are grouped by replacement
owner rather than by source file.

### Dispatch and overlay, 14 members

`request`, `setOverlayPreferences`, `setOverlayBusy`, `setKeybinds`,
`onShortcutRequest`, `completeShortcutRequest`, `openOverlay`,
`setOverlayHeight`, `onOverlaySurface`, `movePill`, `expandPill`,
`dismissOverlay`, `openWorkspace`, `resyncWindow`.

`request` is the 23-method validated app/host request surface, not a generic
escape hatch. The native equivalent must retain the allowlist and field
limits in `desktop/main/ipc.ts`.

### Voice, Quick Ask, and update, 10 members

`voiceStatus`, `transcribe`, `onOpenSettings`, `sendQuickCommand`,
`onQuickCommand`, `onNewQuickSession`, `onNotchHover`, `updateReady`,
`installUpdate`, `onUpdateReady`.

### Streaming and context events, 6 members

`onDelta`, `onStep`, `onCompacted`, `onContextExperiment`, `onRoutedModel`,
`onContextBreakdown`.

### Screen context and annotation, 8 members

`startScreenAnnotation`, `onScreenContext`, `captureScreenContext`,
`getScreenAnnotationFrame`, `finishScreenAnnotation`, `cancelScreenAnnotation`,
`screenAnnotationStatus`, `clearScreenAnnotation`.

### Artifacts, components, and visuals, 19 members

`revealPath`, `previewPath`, `listArtifacts`, `readArtifact`, `saveArtifact`,
`deleteArtifact`, `revealArtifact`, `artifactSql`, `onArtifactsChanged`,
`listComponents`, `readComponent`, `deleteComponent`, `enableComponent`,
`expandComponent`, `componentFetch`, `shootComponent`, `onComponentsChanged`,
`readVisual`, `exportVisual`.

### Plans, task lists, and thread export, 8 members

`listPlans`, `listTaskLists`, `setGoal`, `updateGoal`, `clearGoal`,
`onPlansChanged`, `onTaskListsChanged`, `exportThreadStats`.

### Folders, marketplaces, and plugins, 10 members

`listFolders`, `pluginCatalog`, `addMarketplace`, `removeMarketplace`,
`refreshMarketplace`, `installPlugin`, `uninstallPlugin`, `pluginDetail`,
`trustPluginHooks`, `onFolderAttached`.

### Setup, vault, and notes, 19 members

`setupStatus`, `openPrivacySettings`, `demoQuickAsk`, `pickVaultFolder`,
`detectVaults`, `setVault`, `vaultStatus`, `installObsidian`, `keep`,
`keepScreen`, `listNotes`, `readNote`, `listNoteFolders`, `createNoteFolder`,
`renameNoteFolder`, `moveNote`, `openInObsidian`, `onNotesChanged`, `resetData`.

### Folder and Git operations, 11 members

`pickFolder`, `forgetFolder`, `listFolderFiles`, `gitStatus`, `gitReady`,
`gitInit`, `gitHistory`, `gitCommit`, `gitDiscard`, `gitRun`, `gitMessage`.

### Mobile pairing and status, 5 members

`mobileStatus`, `mobilePair`, `mobileCancelPair`, `mobileUnpair`,
`onMobileStatus`.

### Machine, editor, worktree, and file reads, 9 members

`machineSample`, `listEditors`, `openInEditor`, `setWorktree`, `worktreeList`,
`worktreeAdd`, `worktreeRemove`, `setBranch`, `readFolderFile`.

### Attachments and imported capabilities, 11 members

`attachFiles`, `attachData`, `readAttachment`, `clearThreadContext`,
`discoverAgentImports`, `importAgentSources`, `searchImportedSkills`,
`selectImportedSkill`, `importedSkillStatus`, `clearImportedSkill`,
`listImportedMcpServers`.

### Computer-use progress, 2 members

`stopComputerRun`, `onComputerRunProgress`.

### Provider, tool, and thread settings, 13 members

`setProviders`, `testProvider`, `setVerifier`, `setToolSettings`, `setZoom`,
`setTagger`, `setHarnessExperiments`, `setImprovements`, `forceArm`,
`listToolTargets`, `capabilityUsage`, `onToolsChanged`, `setThreadContext`.

### Background and external CLI runs, 14 members

`runCommand`, `listBackground`, `readBackground`, `stopBackground`,
`onBackground`, `listCliRuns`, `readCliRun`, `stopCliRun`, `installedClis`,
`signInCli`, `cliModels`, `setCliRunModel`, `sendCliRun`, `onCliRuns`.

### Browser, 11 members

`browserStatus`, `browserOpen`, `browserNav`, `browserPlace`, `browserClips`,
`browserClipUse`, `browserNewTab`, `browserSelectTab`, `browserCloseTab`,
`onBrowser`, `onBrowserShow`.

### Terminal, 8 members

`openTerminal`, `writeTerminal`, `resizeTerminal`, `closeTerminal`,
`listTerminals`, `readTerminal`, `onTerminalData`, `onTerminals`.

### Harness and ACP status, 3 members

`harnessReport`, `restartHarness`, `onHarnessLog`.

### Links, memory, agent, traces, and permissions, 16 members

`openLink`, `listMemories`, `deleteMemory`, `listAgents`, `listSpans`,
`livePartial`, `threadTraces`, `steerAgent`, `stopAgent`, `answerPermission`,
`threadChanges`, `revertChange`, `onAgents`, `onSpans`, `onPermissionAsk`,
`onPermissionResolved`.

### Credentials, network, and UI plugins, 10 members

`setZeroRetention`, `listCredentials`, `openRouterBalance`, `deepseekBalance`,
`saveCredential`, `fetchUrl`, `clipPage`, `loadUiPlugins`, `onChanged`,
`offChanged`.

Total: 207 callable members in 21 groups, 35 event subscriptions, and the
`platform` value. The native app should replace this object with typed Rust
commands/events; preserving the names as a compatibility checklist is useful,
but preserving a stringly typed bridge is not.

## Request and process contracts

The renderer-facing request allowlist in `desktop/main/ipc.ts` has 23 methods:

`snapshot`, `threadSummaries`, `thread`, `createThread`, `setThreadArchived`,
`renameThread`, `sendMessage`, `saveScheduledJob`, `deleteScheduledJob`,
`runScheduledJob`, `setScheduledJobEnabled`, `saveResearchJob`,
`deleteResearchJob`, `setResearchJobStatus`, `setResearchJobThread`,
`recordResearchIteration`, `listOpenRouterModels`, `selectOpenRouterModel`,
`setThreadModel`, `selectProviderModel`, `selectCodexModel`,
`selectFallbackModel`, `setRouters`.

The host dispatch in `crates/host/src/main.rs` has 23 methods, but it is not
the same list. Host-only persistence methods include `recordTurn`,
`setGoal`, `updateGoal`, `clearGoal`, `recordTrace`, `readTrace`,
`finishScheduledJob`, `fireScheduledEvent`, and the complete research/store
set. `sendMessage` is app orchestration: `desktop/main/main.ts` intercepts it,
starts `driveTurn`, and then records the result through the host. A native
client must preserve that distinction.

The current runtime has four processes and three trust boundaries. The native
shape has three processes after the renderer is removed, but must retain the
same logical boundaries:

| Boundary | Existing owner | Native owner |
| --- | --- | --- |
| View to trusted desktop | `contextBridge` plus `trustedFrame` | GPUI action/event dispatch; validate all external/plugin/webview inputs at the app edge |
| Desktop to durable store | `Host` in `desktop/main/main.ts` over NDJSON | GPUI host client over the same NDJSON protocol |
| Desktop to agent | `Harness` in `desktop/main/harness.ts` over ACP | GPUI ACP client; keep `emma-cli` unchanged initially |
| Model/tool to user computer | `toolGate` and permission state in `desktop/main` | Native app permission state and the same gate table |

## Electron-only replacement map

### Windowing and application controls

`desktop/main/main.ts` imports `app`, `BrowserWindow`, `dialog`,
`globalShortcut`, `ipcMain`, `nativeImage`, `Notification`, `powerMonitor`,
`protocol`, `screen`, `session`, `shell`, and `systemPreferences`. These are
not available through GPUI itself. A native owner needs:

- GPUI windows for workspace, overlay, annotation, hotspot, radial commands,
  run banner, and computer cursor;
- transparent always-on-top panels, visible-on-all-workspaces behavior,
  click-away/escape rules, window focus rules, and the current geometry;
- native open/save panels, URL/file reveal, system notifications, app
  activation, power/session events, and single-instance locking;
- macOS AppKit/ApplicationServices interop for global shortcuts, notch/safe
  area geometry, event taps, screen selection, Accessibility/TCC status, and
  frontmost-app information. The existing helper sources are a useful narrow
  boundary, not a replacement for window lifecycle.

`desktop/main/overlay.ts` contains pure geometry that should be ported with
fixtures. `docs/notch.md` defines the user-visible Quick Ask state machine.
The main workspace defaults are 1380x860, minimum 1040x680; pane defaults are
sidebar 260, inspector 288, browser 420, and terminal height 260 from
`desktop/src/layout.ts`.

### Browser and arbitrary web content

`desktop/main/browser.ts` uses Electron `WebContentsView`;
`desktop/src/browser.tsx` asks main to place it by bounds. `components.ts`,
`artifacts.ts`, and `visuals.ts` also rely on privileged content schemes or
HTML/JavaScript surfaces. A GPUI text renderer cannot reproduce arbitrary
websites or user-authored HTML/React widgets exactly.

The native design needs one of these explicit choices before browser/component
parity is claimed:

1. an embedded WKWebView/AppKit adapter on macOS with a tightly scoped bridge,
   preserving no file access, no ambient credentials, CSP, navigation, and
   approval rules; or
2. a retained Chromium/webview process with an equivalent visible embedding
   surface.

A headless CDP browser is insufficient because the current product exposes the
   live page and supports visible tabs, navigation, placement, clipping, and
   selection. Rasterizing HTML into a GPUI image is also insufficient for
   typing, scrolling, links, selection, accessibility, and focus behavior.

### Terminal

`desktop/main/terminal.ts`, `desktop/src/terminal.tsx`, and
`desktop/src/terminal-implementation.tsx` depend on xterm.js rendering over
the native PTY helper. Reuse `desktop/native/pty.c` or `pty_win.c` for shell
processes and resizing, but use a GPUI terminal implementation for parsing,
cursor, selection, scrollback, IME, and keyboard semantics. The current limits
are eight shells and 256 KiB main scrollback; `docs/terminal.md` is the
behavior contract.

### Screen context, annotation, and computer use

`desktop/main/computer.ts`, `vision.ts`, `attachments.ts`, and the annotation
handlers in `main.ts` depend on Electron capture/image APIs and the native
computer helper. Port the capture pipeline to ScreenCaptureKit or the existing
helper, preserve the JPEG/data-size limits, and make the annotation surface a
native transparent window. Computer progress needs a native banner and cursor
surface with the same stop and permission behavior. This area cannot be signed
off without exercising macOS Screen Recording and Accessibility permissions.

### Secure storage and credentials

`desktop/main/credentials.ts` and `pairing.ts` use Electron `safeStorage`.
The replacement is macOS Keychain/Security framework or a small audited native
helper, with an OS credential-store fallback on Windows. Preserve the refusal
when secure storage is unavailable. Never replace this with a plaintext JSON
file or a GPUI view-owned secret.

### Attachments, images, clipboard, and editors

`attachments.ts`, `clip.ts`, `editors.ts`, `folders.ts`, `vault.ts`,
`git.ts`, and `visuals.ts` use Node filesystem/process APIs plus Electron
dialogs, clipboard, image decoding, and shell integration. These can move to a
trusted Rust capability module, but each path must keep the existing grant,
path-inside, size, MIME, and approval checks. The native owner needs AppKit
open panels, NSWorkspace URL/file reveal, NSPasteboard, image metadata, and
editor discovery. Windows and non-macOS behavior remains unverified until
their platform adapters are exercised.

### Agent, background, CLI, and mobile lifetimes

`desktop/main/agent-loop.ts`, `harness.ts`, `background.ts`, `cli.ts`,
`codex.ts`, `bridge.ts`, `pairing.ts`, and `research.ts` are process and async
orchestration, not UI. The Rust/native owner needs cancellation-safe task
handles, ACP update routing, permission request correlation, background/CLI
supervision, mobile WebSocket/crypto state, and trace/event fan-out. The
existing Zig harness remains the source of agent/tool/provider behavior until
the native ACP client is stable.

### Plugins and content schemes

`capabilities.ts`, `marketplace.ts`, `plugins.ts`, and the renderer's
`loadUiPlugins` path write/read skills, tools, MCP manifests, and plugin CSS.
The native app must retain manifest validation, hook trust hashes, CSS caps,
no `@import`/`url(`, and the permission model. A GPUI stylesheet loader cannot
blindly inject arbitrary plugin CSS; translate the approved subset into native
theme/layout tokens or isolate plugin UI in the webview boundary described
above.

### Updates and voice

`desktop/main/update.ts` uses Electron `autoUpdater`; `voice.ts` launches the
Speech.framework helper. Voice can reuse the helper protocol early. Updating
needs a separate Sparkle/native updater decision and should not be in the
first parity slice; do not report update parity while it remains Electron
specific.

## Data and state migration

`emma-core` owns `threads/`, `scheduled/`, and `research/` under
`$EMMA_DATA_DIR` or the platform default. Keep that root and all Markdown
formats unchanged. The rest of the current Electron user data is listed in
`docs/data.md` and includes:

- `vault.json`, `credentials.json`, `folders.json`, `mcp.json`,
  `imports.json`, installed plugins, hook trust hashes, mobile peers, and the
  model catalog;
- artifacts, components, plans, task lists, skills, tools, memories,
  attachments, workspaces, marketplaces, plugin data, and harness home;
- Chromium cache/session files, which should disappear when web content is
  moved to the chosen native webview boundary;
- renderer `localStorage` keys for settings, pane layout, setup/import flags,
  overlay draft/mode, context page, improvements, and per-thread mode/draft/
  tags/attachments/blocks/cleared/experiments/context metrics.

The native app needs a versioned preferences file or store with atomic writes.
At first launch it must either import the existing Chromium local-storage
values or intentionally start clean with a documented migration prompt. For a
true side-by-side parity test, import is required so layout, model, keybind,
permission, and draft state do not silently diverge. Validate settings with
the same limits currently enforced by `desktop/shared/settings.ts`.

Do not let GPUI views write the data root directly. Route writes through the
trusted app capability layer and keep host-owned records behind the host
client. Vault files remain in the user's vault and reset must never delete
them.

## UI surface inventory

`desktop/src/App.tsx` has 5,130 lines and is the composition root. The current
tree contains 38 TSX files, 22 CSS files including `index.css`, and 81 source
files. The top-level query surfaces are seven:

- `Workspace`;
- `Overlay`;
- `ScreenAnnotation`;
- `NotchHotspot`;
- `RadialCommands`;
- `ComputerRunBanner`;
- `ComputerActivityCursor`.

`Workspace` has nine modes: threads, knowledge, artifacts, agent, scheduled,
plugins, research, archive, and settings. Its navigation constants are in
`desktop/src/layout.ts`: knowledge, artifacts, scheduled, agent, plugins, and
research. Settings has 15 pages in `desktop/src/App.tsx`:

`keybinds`, `notch`, `voice`, `appearance`, `contextbar`, `models`, `prompts`,
`tools`, `permissions`, `harness`, `imports`, `mobile`, `built`, `privacy`,
and `about`.

The component/view files to port include `ActivityView.tsx`, `AgentView.tsx`,
`App.tsx`, `BenchPanel.tsx`, `WorktreesView.tsx`, `agents.tsx`,
`artifacts.tsx`, `bars.tsx`, `browser.tsx`, `cli.tsx`, `color-picker.tsx`,
`components.tsx`, `context-bar.tsx`, `editors.tsx`, `git.tsx`, `goal.tsx`,
`harness.tsx`, `icons.tsx`, `machine.tsx`, `markdown.tsx`,
`mermaid-artifact.tsx`, `mobile.tsx`, `model-plans.tsx`, `pane-switch.tsx`,
`pip.tsx`, `plan.tsx`, `plugins.tsx`, `preview.tsx`, `regions.tsx`,
`research.tsx`, `run-block.tsx`, `schedule.tsx`, `task-list.tsx`,
`terminal-implementation.tsx`, `terminal.tsx`, `timeline.tsx`, and
`visual.tsx`. Supporting state/format modules such as `context.ts`, `drafts.ts`,
`layout.ts`, `markdown-parse.ts`, `runs.ts`, `threads.ts`, and `types.ts` are
part of the behavioral contract even when they do not render a component.

The 1:1 visual gate must cover typography, font loading, accent/theme tokens,
pane widths, scrolling, resize handles, focus rings, menus, drag/drop,
selection, keyboard shortcuts, reduced motion, IME, clipboard, screen-reader
labels, and error/empty/loading states. A screenshot that matches only the
happy-path workspace is not parity.

## Risk gates

The native branch is not ready to call itself Electron-free or 1:1 until each
gate passes on a clean build and with the existing data root:

1. Launch and single-instance behavior use the GPUI binary; no Electron import,
   BrowserWindow, preload, or hidden renderer remains in the runtime path.
2. Workspace load, thread list, open/create/rename/archive, composer send,
   streaming delta/step, stop, permission allow/deny, and durable reload match
   existing fixtures and observed behavior.
3. All seven top-level surfaces and all 15 settings pages launch, resize, and
   route correctly; keyboard/focus/accessibility checks are exercised.
4. Screen capture, annotation, Quick Ask/notch geometry, global shortcut,
   computer-use progress, and voice are exercised with their macOS privacy
   grants and denial paths.
5. Browser visible interaction, tabs, clipping, component fetch, HTML/app
   artifacts, and visual export have an explicitly tested webview boundary.
6. Terminal PTY, parser, scrollback, selection, resize, IME, and shell
   lifecycle match the current xterm surface.
7. Git, folder grants, notes/vault, attachments, editor launch, marketplace,
   plugins, memory, background/CLI runs, mobile pairing, and credentials pass
   data-integrity and permission tests.
8. Host and ACP malformed input, oversized lines, chunk ordering, child EOF,
   cancellation, and restart/recovery tests pass.
9. The app is visually compared at fixed geometries and multiple scale/theme/
   content states. VoiceOver, display geometry, signing/notarization, and
   non-macOS paths are reported separately when unverified.

## First implementation slice

The first delegable vertical slice should be the main conversation path:

1. Add one native GPUI application binary with a typed internal command/event
   model. Keep it small; do not introduce a service locator or plugin
   framework.
2. Connect to `emma-host` and prove `snapshot`, `threadSummaries`, `thread`,
   `createThread`, `setThreadArchived`, `renameThread`, `recordTurn`, and
   trace/error handling against a temporary `EMMA_DATA_DIR`.
3. Implement a non-Electron ACP client for `emma-cli` sufficient for one
   prompt, incremental `session/update`, permission requests, cancellation,
   and durable `recordTurn`. This is the native replacement for the minimum
   `sendMessage` path; `sendMessage` is not a host dispatch method.
4. Port the workspace shell, sidebar/thread list, selected-thread transcript,
   composer, loading/error/empty states, and streaming indicator from
   `desktop/src/App.tsx` and its conversation styles. Use the existing pane
   dimensions, tokens, fonts, Markdown rules, and keyboard semantics as
   fixtures.
5. Exercise create/open/send/stream/stop/deny/reload at a fixed 1380x860
   window, then compare screenshots and interaction traces against Electron.

This slice deliberately leaves browser, terminal, Quick Ask, screen context,
computer use, plugins, and arbitrary HTML surfaces behind explicit risk gates.
It proves the native process boundary, storage protocol, ACP lifecycle, and
the most frequently used UI before delegating the high-risk adapters. Once it
passes, split follow-on work by boundary: native window/Quick Ask, webview,
terminal, capture/computer, secure storage, and remaining views. Do not claim
the branch is done merely because all JSX has been visually redrawn; every
API group and every risk gate above must be exercised.
