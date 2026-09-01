---
name: start-emma
description: Start, restart, or visually verify Emma from this repository in isolated Vite development mode, as a packaged production app, or with the production renderer bundle. Not for publishing a release.
---

# Start Emma

Run commands from the repository root. Preserve every Emma process you did not
start unless the user explicitly asks to stop or restart it.

## Isolated development

Use this by default for development and UI validation. It runs beside production
Emma without taking its profile or touching its data.

Only `desktop/src/**` hot-reloads without an Electron restart. Build only the
layer that changed:

- Cold checkout or missing outputs: run all three commands below, sequentially.
- `desktop/main/**` or `desktop/shared/**`: `build:main`, then relaunch Electron.
- `crates/**` or `harness/**`: `build:host`, then relaunch Electron.
- `desktop/native/**`: `build:native`, then relaunch Electron.
- `desktop/src/**`: let Vite hot-reload; do not rebuild or relaunch.

```sh
npm --prefix desktop run build:host
npm --prefix desktop run build:native
npm --prefix desktop run build:main
```

If `desktop/node_modules/.bin/electron` is missing, install the locked desktop
dependencies with `npm --prefix desktop ci` before building.

Use two owned long-running terminal sessions. Do not hide them behind `&`.
Start Vite first:

```sh
npm --prefix desktop exec -- vite --host 127.0.0.1 --strictPort
```

Wait until Vite prints `http://127.0.0.1:5173/`, then start Electron in the
second session:

```sh
EMMA_DATA_DIR=/tmp/emma-dev-data \
EMMA_DEV_SERVER_URL=http://127.0.0.1:5173 \
./desktop/node_modules/.bin/electron ./desktop \
  --user-data-dir=/tmp/emma-dev-profile
```

Keep the fixed `/tmp` paths so development settings survive relaunches. If port
5173 is occupied, do not stop an unknown listener. Use the next free port,
update `EMMA_DEV_SERVER_URL`, and suffix both `/tmp` paths with that port.

Localhost binding and GUI launch may need sandbox escalation. Retry the same
command with the required permission instead of changing the host, disabling
Electron security, or launching production Emma.

### Verify the right window

For Computer Use, target the development Electron bundle by its resolved full
path, not by the ambiguous names `Emma` or `Electron`. Put the literal path in
the `app` property:

```js
await sky.get_app_state({ app: "/absolute/repository/desktop/node_modules/electron/dist/Electron.app", disableDiff: true })
```

The correct window reports `Window: "Emma"` and the Vite URL. Fetch fresh app
state after every interaction before reusing accessibility element indexes.

### Restart and stop

For a main, host, or native change, stop only the Electron session, rebuild the
affected layer, and relaunch it while Vite stays up. Restart both sessions only
for Vite configuration or dependency changes.

If the user asked to launch Emma for their use, leave both sessions running. If
the instance exists only for a validation task, send Ctrl-C to Electron and then
Vite when the task is finished. Never use `pkill` or `killall`; production Emma
may be running beside it.

`npm run dev` performs the full builds and starts Vite and Electron, but it uses
the default profile and data and launches Electron after a fixed delay. Use it
only when no other Emma is running and isolated state is intentionally unwanted.

## Production Emma

Production means a packaged `Emma.app`, not `electron .`. Start the installed
release by exact path so macOS cannot choose another registered copy:

```sh
open /Applications/Emma.app
```

When the user asks to build this checkout as production, package and open its
unsigned local bundle:

```sh
npm run package:mac
open "$PWD/desktop/release/Emma-darwin-arm64/Emma.app"
```

Do not rebuild merely to start an existing app. Packaged Emma has no hot reload
and uses production data.

## Production-renderer smoke test

Use this only when the user wants unbundled Electron against `dist-renderer`
without Vite. It rebuilds the app but is not packaged production:

```sh
EMMA_DATA_DIR=/tmp/emma-smoke-data \
npm --prefix desktop start -- \
  --user-data-dir=/tmp/emma-smoke-profile
```
