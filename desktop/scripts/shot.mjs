// Dev-only: drive the running dev Electron over CDP to capture view screenshots.
// Usage: node scripts/shot.mjs <port> <out-dir> [width] [height]
import { writeFileSync } from "node:fs";

const [port = "9223", outDir = "/tmp/emma-shots", width = "1440", height = "900"] = process.argv.slice(2);

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === "page" && !t.url.includes("?"));
if (!page) throw new Error("no workspace page target");

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve) => socket.addEventListener("open", resolve));

let id = 0;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
  }
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  pending.set(++id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});

const evaluate = async (expression) => {
  const { result, exceptionDetails } = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (exceptionDetails) throw new Error(exceptionDetails.text + " " + (exceptionDetails.exception?.description ?? ""));
  return result.value;
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const shot = async (name) => {
  const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(`${outDir}/${name}.png`, Buffer.from(data, "base64"));
  return name;
};

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: Number(width), height: Number(height), deviceScaleFactor: 2, mobile: false });
// The window holds whatever bundle it booted with, so without this every capture
// silently documents a stale build — which is worse than no capture at all.
// ponytail: fixed 1.2s settle rather than waiting on a load event; bump if the
// first frame ever lands mid-render.
await send("Page.reload", { ignoreCache: true });
await wait(1200);

// Threads, Knowledge Base, Agent, Scheduled live in .sidebar-nav; Settings is
// the gear in the foot, so select by data-view rather than by position.
const clickNav = (view) => evaluate(`document.querySelector('[data-view="${view}"]').click(), true`);

const done = [];
for (const view of ["threads", "knowledge", "agent", "scheduled", "archive", "settings"]) {
  await clickNav(view);
  await wait(700);
  done.push(await shot(view));
}

// Settings sub-pages, in sub-nav order.
const settingsCount = await evaluate(`document.querySelectorAll(".settings-sidebar button").length`);
for (let index = 1; index < settingsCount; index++) {
  await evaluate(`document.querySelectorAll(".settings-sidebar button")[${index}].click(), true`);
  await wait(700);
  done.push(await shot(`settings-${index}`));
}

// Back to threads, then open the composer add-menu and the model dialog.
await clickNav("threads");
await wait(500);
await evaluate(`document.querySelector(".source-trigger")?.click(), true`);
await wait(600);
done.push(await shot("composer-add-menu"));
await evaluate(`document.querySelector(".source-popover header button")?.click(), true`);
await wait(300);
await evaluate(`document.querySelector(".model-button")?.click(), true`);
await wait(900);
done.push(await shot("model-menu"));
// ...and one level in. The root pane is three label/value rows; the model list
// with its vendor marks and tab stops only exists inside the Model pane, and a
// bare `.model-menu button` selector picks the header's close mark instead.
await evaluate(`[...document.querySelectorAll(".model-menu-row.pair")].find((row) => row.textContent.trim().startsWith("Model"))?.click(), true`);
await wait(600);
done.push(await shot("model-menu-submenu"));

console.log(done.join(" "));
socket.close();
