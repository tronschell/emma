import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const [executable, screenshotArgument] = process.argv.slice(2);
if (!executable || !screenshotArgument) throw new Error("Usage: node scripts/install-smoke.mjs <executable> <screenshot.png>");

const screenshot = path.resolve(screenshotArgument);
const scratch = path.join(process.env.RUNNER_TEMP ?? tmpdir(), "emma-install-smoke");
const profile = path.join(scratch, "profile");
const dataRoot = path.join(scratch, "data");
rmSync(scratch, { recursive: true, force: true });
mkdirSync(profile, { recursive: true });
mkdirSync(dataRoot, { recursive: true });
mkdirSync(path.dirname(screenshot), { recursive: true });

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(what, timeoutMs, probe) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await wait(250);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
}

const app = spawn(executable, [`--user-data-dir=${profile}`, "--disable-gpu"], {
  env: { ...process.env, EMMA_DATA_DIR: dataRoot },
  stdio: ["ignore", "inherit", "inherit"],
});

const portFile = path.join(profile, "DevToolsActivePort");
const port = await waitFor("the DevTools port file", 120_000, () => {
  if (app.exitCode !== null) throw new Error(`Emma exited with code ${app.exitCode} before writing ${portFile}`);
  const lines = existsSync(portFile) ? readFileSync(portFile, "utf8").split("\n") : [];
  return lines.length > 1 ? lines[0].trim() : "";
});

const endpoint = `http://127.0.0.1:${port}`;
const browser = await waitFor("the DevTools endpoint", 60_000, () => fetch(`${endpoint}/json/version`).then((response) => response.json()).catch(() => null));
const target = await waitFor("the main window target", 120_000, async () => {
  const targets = await fetch(`${endpoint}/json/list`).then((response) => response.json()).catch(() => []);
  return targets.find((entry) => entry.type === "page" && entry.url.endsWith("dist-renderer/index.html"));
});

const socket = new WebSocket(target.webSocketDebuggerUrl);
await waitFor("the DevTools WebSocket", 30_000, () => socket.readyState === WebSocket.OPEN);

let nextId = 0;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  const settle = pending.get(message.id);
  if (!settle) return;
  pending.delete(message.id);
  if (message.error) settle.reject(new Error(JSON.stringify(message.error)));
  else settle.resolve(message.result);
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  pending.set(++nextId, { resolve, reject });
  socket.send(JSON.stringify({ id: nextId, method, params }));
});

const evaluate = async (expression) => {
  const { result, exceptionDetails } = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (exceptionDetails) throw new Error(exceptionDetails.text);
  return result.value;
};

await send("Page.enable");
await send("Runtime.enable");

const shellClass = await waitFor("the .app-shell element", 120_000, async () => {
  const value = await evaluate('document.querySelector(".app-shell")?.className ?? ""');
  return value.includes("app-shell") ? value : "";
});

const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
writeFileSync(screenshot, Buffer.from(data, "base64"));

console.log(`Browser: ${browser.Browser}`);
console.log(`Page: ${target.url}`);
console.log(`Shell: ${shellClass}`);
console.log(`Screenshot: ${screenshot}`);

await evaluate("window.close(), true").catch(() => {});
socket.close();
const stopped = () => app.exitCode !== null || app.signalCode !== null;
const closed = await waitFor("Emma to quit", 30_000, stopped).catch(() => false);
if (!closed) {
  app.kill();
  await waitFor("Emma to stop", 30_000, stopped);
}
