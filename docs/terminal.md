# The terminal panel

A real shell at the foot of the thread, opened in the folder that thread is
working out of. Select output with the mouse and it becomes a context chip on the
composer; Command-click on macOS or Ctrl-click on Windows a URL and Emma asks
which browser should take it.

| | |
| --- | --- |
| pty helper | [native/pty.c](../desktop/native/pty.c) or [native/pty_win.c](../desktop/native/pty_win.c) → `emma-pty` or `emma-pty.exe` |
| The shells | [main/terminal.ts](../desktop/main/terminal.ts) |
| The panel | [src/terminal.tsx](../desktop/src/terminal.tsx), [styles/terminal.css](../desktop/src/styles/terminal.css) |
| Bounds and the two shared helpers | [shared/terminal.ts](../desktop/shared/terminal.ts) |

The surface is drawn by [xterm.js](https://github.com/xtermjs/xterm.js) —
`@xterm/xterm` 6.0.0 with `@xterm/addon-fit` and `@xterm/addon-web-links`, MIT.

## Opening it

The terminal icon sits in the thread bar, left of the globe. Both are the same
control — `PaneSwitch` in [src/pane-switch.tsx](../desktop/src/pane-switch.tsx) —
so hiding and closing mean the same thing in both places:

| | |
| --- | --- |
| **Hide** | The panel goes away. Every shell keeps running, keeps its scrollback, and is still there when you open it again. |
| **Close** | Every shell in this thread is ended and its buffer dropped. |

Pressing the icon while the panel is open asks which of the two you meant — but
only if a shell is still running. With nothing live it just hides. Opening the
panel on a thread that has no shell starts one.

The panel is the second row of `.thread-layout` and spans every column, so it
runs under the inspector and the browser rather than beside them. Its height is
`--terminal-height`, dragged from the rule along its top edge, clamped to
120–720px (default 260) by `validatePaneLayout`, and capped by the grid at 60% of
the window.

## Where the shell starts

The renderer never names a directory. It sends a thread id, and main resolves the
cwd itself:

```ts
terminals.open({ threadId, cwd: folders!.directory(grantFor(threadId, undefined)), columns, rows })
```

`grantFor` is the same folder grant the agent's own tools are gated on, so the
shell can only ever start somewhere this thread already has — and a thread with
no folder connected cannot open one at all. Swapping a thread onto a worktree
rewrites that grant, so a terminal opened afterwards starts in the worktree.

The panel's auto-start is keyed on the thread *and* the folder it is pointed at.
Point a thread whose folder could not open a shell at a healthy one and the pane
clears the old error and starts a shell there; shells already running keep the
cwd they were opened in.

On macOS the shell is `$SHELL` (falling back to `/bin/zsh`) run as `-il` —
interactive and login, so your rc files, prompt and PATH are the ones you
already have. On Windows it is PowerShell — `pwsh.exe` when PowerShell 7 is
installed, otherwise the `powershell.exe` every Windows ships — run as `-NoLogo`
so your own profile still loads but the banner does not. That is the same shell
the agent's `terminal` tool targets, so what you type in the panel and what the
model writes are one language. `TERM` is `xterm-256color` and `COLORTERM` is
`truecolor`. The tab is named after the last segment of the cwd, or `shell` if
that is empty or over 40 characters.

Emma does not offer `cmd.exe` or Git Bash as the panel's shell. Either is one
`cmd` or `bash` away inside the PowerShell session, and neither is what the
model is told it has.

A thread keeps at most 8 shells. `+` opens another; the `×` on a tab ends that
one; the `×` at the right of the strip hides the panel.

## The pty

`node-pty` is a native module and would need a rebuild for every Electron
release. Instead the platform helper (`native/pty.c` on macOS or
`native/pty_win.c` on Windows) builds to `emma-pty` or `emma-pty.exe` beside the
other helpers in `dist-native/`, from the same `build:native` script, and ships
as an `--extra-resource`:

```
emma-pty <columns> <rows> <command> [argument...]
```

On macOS it calls `forkpty(3)` at that size, `execvp`s the command in the child,
and relays stdin ⇄ the pty master with one `poll()`. On Windows it creates a
ConPTY session and relays the same streams through its pipes. Resize travels on
the helper's control stream as `"COLS ROWS\n"`; the platform helper applies it
to the active terminal.

`emma-pty --self-test` starts a platform shell at 40×10 and asserts the terminal
size. It runs as part of `build:native`, so a broken helper fails the build
rather than the app.

## Scrollback and replay

Main keeps the last 256KB of each shell's output and a monotonic byte count of
everything ever written to it. Live output is broadcast as `emma:terminal-data`
with that offset attached.

A surface that mounts mid-session subscribes first and queues what arrives, then
reads the saved buffer, writes it, and replays only the queued chunks whose
offset is past the buffer's. Without the offset the two paths overlap and the
same line is drawn twice.

xterm.js keeps its own 5000-line scrollback in the surface; the 256KB in main is
what survives hiding the panel.

## Selecting output

Release the mouse after dragging and the selection becomes a chip above the
composer, sent with the next turn like any other attachment.

`terminalSelection` in `shared/terminal.ts` is what bounds it: carriage returns
go, each line is right-trimmed, blank lines top and bottom are dropped, and an
empty selection attaches nothing. Past 200 lines the tail is cut and the text
ends `[N more lines not attached]`; past 16KB it is cut at the character. The
chip reads `Terminal · N lines of output · next turn only`.

One chip per shell: `addPick` replaces on a repeated `pickKey`, and a terminal's
key is its shell id.

The Git panel highlights the same way, through the same trimmer: release the
mouse inside one file's diff and the excerpt attaches as `Diff · path · N lines`,
keyed on the path. A selection spanning two files has no one path to claim, so
it attaches nothing.

## Links

xterm's web-links addon finds URLs in the output. A plain click does nothing: the
handler returns unless the platform modifier is held (`metaKey` on macOS,
`ctrlKey` on Windows), so Command-click or Ctrl-click is the gesture and ordinary
selection is never interrupted by a stray link. That gesture opens a small menu
at the pointer:

| | |
| --- | --- |
| **Emma's browser** | Opens the browser pane on this thread and loads it there — the same page the agent can see. |
| **Default browser** | `emma:open-link` → `shell.openExternal`. |

`emma:open-link` caps the string at 2048 characters and runs it through
`externalUrl`, so only `http` and `https` ever reach the system browser.

## What main will not accept

| Channel | Bound |
| --- | --- |
| `emma:terminal-open` | thread id through `boundedCapabilityId`; columns and rows are safe integers in 1–4096; cwd is main's, never the renderer's |
| `emma:terminal-write` | at most 64KB of input, and only to a shell that is still running |
| `emma:terminal-resize` | same 1–4096 size check |
| `emma:terminal-close`, `-list`, `-buffer` | id through `boundedCapabilityId` |

Every handler goes through `mainWindowSender(event)` first, so a renderer that is
not Emma's own window is refused before any of this runs.

Quitting terminates every shell's process tree and forces it after two seconds if
one has not gone.

## The agent's durable sessions

The panel is not the only shell in the app. `terminal.start` opens a durable
session that outlives the `emma-cli` process that asked for it: a background
terminal host holds the sessions, and every later `list`, `read`, `write`,
`wait` and `close` reaches it over a socket in the profile's `terminal-host`
directory (or under `%TEMP%` when that path would exceed the 108-byte
`sockaddr_un` limit).

| | |
| --- | --- |
| Transport | [core/terminal/endpoint.zig](../harness/src/core/terminal/endpoint.zig) |
| The host | [core/terminal/host.zig](../harness/src/core/terminal/host.zig) |
| Sessions and the launcher | [core/terminal/native_session.zig](../harness/src/core/terminal/native_session.zig) |

The endpoint is an `AF_UNIX` stream socket on every platform. On Windows the
socket is created through Winsock rather than the `AF_UNIX` support in Zig's
standard library, because the standard library opens the socket directly on
`\Device\Afd` and every `ws2_32` call the host needs — `WSAPoll` to wait for a
connection without blocking the idle timer, `SIO_AF_UNIX_GETPEERPID` to name the
peer process, and the send and receive timeouts — answers `WSAENOTSOCK` on a
handle Winsock never issued. Winsock handles are AFD handles underneath, so
reads and writes still go through the standard library. `receiveTimeout` is not
implemented for Windows in Zig 0.16, so the endpoint waits with `WSAPoll` and
then reads. A path is capped at 108 bytes and is interpreted by the ANSI code
page, so a profile directory that is not representable there falls back to
`%TEMP%`.

Each session runs under a launcher process, which puts the shell in a ConPTY and
a job object. The terminal side of the ConPTY is a duplex named pipe with a
random name that only the launcher is told; the launcher opens it by name
because the standard library hands a child a write-only stdout. The shell is
started with `STARTF_USESTDHANDLES` and null standard handles, so it inherits
the pseudo console instead of the launcher's own redirected streams, and the
pseudo console handle is passed to `UpdateProcThreadAttribute` by value.

Killing the host takes the whole tree with it: the launcher sees its standard
input close, and its job object is created kill-on-close, so the shell and
everything it started go with it. Cancelling or force-closing a session
terminates the launcher, which trips the same job.

The bootstrap that reports readiness is a real PowerShell script — PowerShell
refuses to run a file whose extension it does not know, so the file is named
`.ps1` (`.cmd` when the pinned shell is `cmd.exe`) and is invoked with the call
operator. It is submitted with a lone carriage return, because PSReadLine reads
a line feed as "insert a newline" and would leave the session at a continuation
prompt.
