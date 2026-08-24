# The terminal panel

A real login shell at the foot of the thread, opened in the folder that thread
is working out of. Select output with the mouse and it becomes a context chip on
the composer; ⌘-click a URL and Emma asks which browser should take it.

The pty helper is [native/pty.c](../desktop/native/pty.c); main owns the shells
in [main/terminal.ts](../desktop/main/terminal.ts); the panel is
[src/terminal.tsx](../desktop/src/terminal.tsx), styled by
[styles/terminal.css](../desktop/src/styles/terminal.css). The bounds and the
two pure helpers both sides share are in
[shared/terminal.ts](../desktop/shared/terminal.ts). Visual tokens are in
[design-system.md](design-system.md) and are not repeated here.

## Opening it

The terminal icon sits in the thread bar, left of the globe. Both are the same
control — `PaneSwitch` in [src/pane-switch.tsx](../desktop/src/pane-switch.tsx),
shared with the browser pane so hiding and closing mean the same thing in both
places:

| | |
| --- | --- |
| **Hide** | The panel goes away. Every shell keeps running, keeps its scrollback, and is still there when you open it again. |
| **Close** | Every shell in this thread is ended and its buffer dropped. |

Pressing the icon while the panel is shut opens it. Pressing it while the panel
is open asks which of the two you meant — but only if something is actually
running. With no live shell there is nothing to lose, so it just hides.

The panel is the second row of `.thread-layout` and spans every column, so it
runs under the inspector and the browser rather than beside them. Its height is
`--terminal-height`, dragged from the rule along its top edge and clamped to
120–720px in `validatePaneLayout`, and the grid caps it at 60% of the window so
a tall terminal cannot squeeze the transcript off screen.

## Where the shell starts

The renderer never names a directory. It sends a thread id, and main resolves the
cwd itself:

```ts
terminals.open({ threadId, cwd: folders!.directory(grantFor(threadId, undefined)), ... })
```

`grantFor` is the same folder grant the agent's own tools are gated on, so the
shell can only ever start somewhere this thread already has. Swapping a thread
onto a worktree rewrites that grant, so a terminal opened afterwards starts in
the worktree with no extra wiring.

The shell is `$SHELL` (falling back to `/bin/zsh`) run as `-il` — interactive and
login, so your rc files, prompt and PATH are the ones you already have. `TERM` is
`xterm-256color` and `COLORTERM` is `truecolor`.

A thread keeps at most 8 shells. `+` opens another; the `×` on a tab ends that
one; the `×` at the right of the strip hides the panel.

## The pty

Emma does not use `node-pty`. It is a native module, so it needs a rebuild for
every Electron version, an `asar` unpack to be spawnable, and an install script
this repo's `allow-scripts` policy does not run. Instead `native/pty.c` builds to
`emma-pty` beside the other helpers in `dist-native/`, from the same
`build:native` script, and ships as an `--extra-resource`:

```
emma-pty <columns> <rows> <command> [argument...]
```

It calls `forkpty(3)` at that size, `execvp`s the command in the child, and in
the parent relays stdin ⇄ the pty master with one `poll()`. Resize is the one
thing a pipe cannot carry, so it travels on **fd 3**: main writes `"COLS ROWS\n"`
there and the helper calls `ioctl(TIOCSWINSZ)`. When fd 3 is absent the helper
notices and skips that pollfd rather than spinning on it.

`emma-pty --self-test` forks `/bin/sh -c "stty size"` at 40×10 and asserts the
shell saw exactly that. It runs as part of `build:native`, so a broken helper
fails the build rather than the app.

## Scrollback and replay

Main keeps the last 256KB of each shell's output and a monotonic byte count of
everything ever written to it. Live output is broadcast as
`emma:terminal-data` with that offset attached.

A surface that mounts mid-session subscribes first and queues what arrives, then
reads the saved buffer, writes it, and replays only the queued chunks whose
offset is past the buffer's. Without the offset the two paths overlap — main has
already appended a chunk to the buffer by the time the broadcast lands — and the
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
chip reads `Terminal · N lines of output`.

One chip per shell. Selecting again in the same terminal replaces what is
attached rather than stacking a second chip — `addPick` replaces on a repeated
`pickKey`, and a terminal's key is its shell id.

## Links

xterm's web-links addon finds URLs in the output. A plain click does nothing: the
handler returns unless `metaKey` is held, so ⌘-click is the gesture and ordinary
selection is never interrupted by a stray link. ⌘-click opens a small menu at the
pointer:

| | |
| --- | --- |
| **Emma's browser** | Opens the browser pane on this thread and loads it there — the same page the agent can see. |
| **Default browser** | `emma:open-link` → `shell.openExternal`. |

Main validates before either. `emma:open-link` caps the string at 2048
characters and runs it through `externalUrl`, the same check the rest of the app
uses, so only `http` and `https` ever reach macOS.

## What main will not accept

Every terminal channel is validated in `main.ts` before it reaches `Terminals`:

| Channel | Bound |
| --- | --- |
| `emma:terminal-open` | thread id through `boundedCapabilityId`; columns and rows are safe integers in 1–4096; cwd is main's, never the renderer's |
| `emma:terminal-write` | at most 64KB of input, and only to a shell that is still running |
| `emma:terminal-resize` | same 1–4096 size check |
| `emma:terminal-close`, `-list`, `-buffer` | id through `boundedCapabilityId` |

Every handler goes through `mainWindowSender(event)` first, so a renderer that is
not Emma's own window is refused before any of this runs.

Quitting sends `SIGHUP` to every shell and `SIGKILL` two seconds later if one has
not gone.
