---
name: building-emma
description: How to build things for yourself inside Emma's own repository — a new interface, main-process behaviour, a skill, a UI plugin, a scheduled job — with the standards to hold to, the commands that build and check each layer, how to launch a second dev instance without killing the Emma you are running in, and how to verify the change actually landed. Use whenever the work changes Emma's own code, harness, or interface rather than the user's files.
---

# Building Emma

You can change yourself. This is how, without breaking the copy of you that is
running while you do it.

This skill ships with the app and is rewritten from `desktop/skills/` on every
launch — do not edit it with `write_skill`. Write what you learn as a separate
skill and it will survive.

## First: get the repository

Everything here needs the Emma checkout connected as this thread's folder. If
nothing is connected, call `connect_folder` with a reason like "the Emma
repository, to change the app itself" — do not describe what the user should do
by hand instead. Confirm you have the right folder: `AGENTS.md`, `desktop/`,
`crates/`, `agent/` and `harness/` sit at its root.

Work on a branch. `git status` first, and leave the tree as you found it apart
from your change.

## What you can build, cheapest first

Take the cheapest thing that actually works. Most requests do not need a rebuild.

1. **A skill** — `write_skill`. A durable lesson or procedure, in Markdown.
   Lands in `<userData>/skills/<slug>/SKILL.md`, is live immediately, and needs
   no build. Reach for this first when the ask is "remember how to do X".
2. **A region of Emma's own interface** — a `code` artifact with `surface` set
   to `navbar`, `chat`, `notch` or `context`. The module replaces that region of
   the running app — real components in the app's own tree, with its props, its
   CSS and its bridge — and every rewrite hot-reloads that region alone: no
   build, no relaunch, nothing to restart. This is the whole of "build yourself
   an interface"; the `artifact` skill has the module contract. A source change
   is for what a region cannot reach: main-process behaviour, IPC or windows.
3. **A UI plugin** — a directory under
   `~/Library/Application Support/Emma/plugins/<id>` holding `plugin.json`
   (`id`, `name`, `version`, `uiStylesheet`) and one CSS file. The directory name
   must equal `id`; `@import` and `url(...)` are rejected; 128 KiB ceiling. CSS
   can restyle and rearrange the whole workspace with no code change. See
   `docs/plugins.md`. Needs a relaunch, not a rebuild.
4. **A scheduled job or a knowledge page** — existing product surfaces, driven
   through the UI or the IPC bridge. No build at all.
5. **A real source change** — new UI, a new tool, new main-process behaviour,
   host or sidecar work. This is the expensive one: it needs a build, a second
   dev instance, and a verified interaction. The rest of this skill is about it.

## Standards

`AGENTS.md` is the contract; read it before the first edit. In short:

- **Respect the layer boundaries.** `desktop/main` owns windows, shortcuts, IPC
  and every privileged runtime; `desktop/src` is a sandboxed renderer with no
  Node access; `crates/host` owns the NDJSON bridge; `crates/core` owns durable
  Markdown records; `agent/` and `harness/` own the model loops. Filesystem,
  process, network and model work never moves into the renderer.
- **Validate at the trust boundary.** Every IPC parameter, NDJSON line, imported
  manifest and model-supplied argument is parsed and bounded where it arrives —
  see `desktop/main/ipc.ts` and `desktop/main/tools.ts` for the house style. Add
  the guard in the shared function, not in each caller.
- **No new dependency, crate, trait, service locator or plugin framework** until
  a second real implementation needs it. One implementation is not a boundary.
- **Shortest diff that works, in the fewest files.** Match the surrounding
  comment density and voice: these files explain *why*, not what.
- Mark a deliberate shortcut with a `ponytail:` comment naming its ceiling and
  the upgrade path, the way the existing ones do. Grep for `ponytail:` to see
  what has already been deferred before you re-decide it.
- Add one runnable check for non-trivial logic. Tests are `node:test` files in
  `desktop/test/*.test.ts`; copy the shape of a neighbour.

## Rebuilding

Only rebuild the layer you touched. Run these with `bash`; they all exit on
their own.

| You changed | Build with | Then |
| --- | --- | --- |
| `desktop/src` (renderer) | `npm --prefix desktop run build:renderer` | reload the window |
| `desktop/main`, `desktop/shared` | `npm --prefix desktop run build:main` | **relaunch Electron** |
| `crates/` | `npm --prefix desktop run build:host` | relaunch |
| `agent/` | `zig build --build-file agent/build.zig` | relaunch |
| `harness/` | `npm --prefix desktop run build:harness` | relaunch, with `EMMA_HARNESS=1` |
| `desktop/native/*.m` | `npm --prefix desktop run build:native` | relaunch |

A cold checkout needs all of it once:

```sh
npm install --prefix desktop
npm --prefix desktop run build:host && npm --prefix desktop run build:native && npm --prefix desktop run build
```

A main-process edit that is not rebuilt *and relaunched* shows up as red
`No handler registered for 'emma:…'` errors in the window. Those are a stale
main process, not a bug in your change.

## Checks

Nothing is done until these pass for the layers you touched:

```sh
npm --prefix desktop run check
cargo fmt --all -- --check
cargo check --workspace --locked --all-targets
cargo test --workspace --locked
cargo clippy --workspace --locked --all-targets -- -D warnings
zig build test -Doptimize=ReleaseSafe --build-file agent/build.zig
```

`npm run check` is test + typecheck + lint + renderer build. Never run two of
them at once — concurrent Vite builds clash over `dist-renderer`. If you fanned
work out to subagents, tell them not to run it and run it once yourself
afterwards.

## Launching a dev instance

**Do not quit the Emma you are running in, and do not ask the user to.** Launch a
second one on its own profile instead.

The packaged app usually holds Electron's single-instance lock, so a plain
`electron .` exits silently with code 0 and looks like a build failure. A
separate `--user-data-dir` is what avoids that. `EMMA_DATA_DIR` keeps the dev
instance's threads and knowledge out of the real store.

```sh
cd desktop && EMMA_DATA_DIR=/tmp/emma-dev-data ./node_modules/.bin/electron . \
  --user-data-dir=/tmp/emma-dev-profile --remote-debugging-port=9223
```

Run it with `bash` and `background: true` — it never exits on its own, so a
foreground call blocks the whole turn until the deadline kills it. Keep the task
id. Read its stdout with the `background` tool when the window misbehaves, and
`stop` it the moment you are finished; a forgotten instance keeps running and
keeps the port.

`npm run dev` also starts Vite for hot renderer reloads, but it launches on the
default profile and will lose the lock race. Prefer the command above.

## Verifying

Launching is not verifying. Exercise the changed interaction, then say what you
saw.

- **Drive the real IPC:** `node desktop/scripts/drive.mjs '<statements>' [ms]`
  runs against `window.emma` in the running window, which is the same path a
  click takes. The argument is an async function *body*, so it needs `return`;
  set `EMMA_CDP_PORT=9223` to point it at your dev instance:

  ```sh
  EMMA_CDP_PORT=9223 node desktop/scripts/drive.mjs \
    'return await window.emma.searchImportedSkills({ query: "build", limit: 8 })'
  ```
- **Look at it:** `node desktop/scripts/shot.mjs 9223 /tmp/emma-shots 1440 900`
  captures every view. It reloads the page first, so a renderer rebuild is picked
  up — but a *main* change still needs the relaunch. Then actually read the PNGs
  with `computer` or the image tools; do not report what you assume they show.
- **A screenshot that disagrees with the source is a stale bundle.** Rebuild the
  renderer, confirm over CDP, and only then believe the picture.
- The overlay is a second window at the same `index.html` with a query string;
  scripts that want the workspace select the bare URL.

Retest loop after any further edit: rebuild the touched layer → relaunch (main)
or reload (renderer only) → re-run `drive.mjs` / `shot.mjs` → re-run
`npm --prefix desktop run check`.

## Finishing

- Report exactly what you verified and what you did not. Unverified privacy
  permissions, VoiceOver behaviour, display geometry, signing and non-macOS paths
  are called out, not implied.
- If a run went badly, `read_trace` it, find the wasted part, and `write_skill`
  so the next one starts smarter.
- Leave the dev instance stopped and `git status` clean apart from the change.
