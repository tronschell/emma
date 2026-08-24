#!/usr/bin/env node
// Drives a running Emma over CDP for manual end-to-end checks: evaluates an
// expression in the main window and prints the result. The renderer's own
// `window.emma` bridge is the surface, so this exercises the same IPC path a
// click does rather than a back door around it.
//
// Usage: node scripts/drive.mjs '<js expression>' [timeoutMs]

const port = process.env.EMMA_CDP_PORT ?? "9222";
const expression = process.argv[2];
const timeout = Number(process.argv[3] ?? 120_000);
if (!expression) {
  console.error("usage: drive.mjs '<expression>' [timeoutMs]");
  process.exit(2);
}

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
// The overlay is an index.html too, but with a query string; the bare one is the
// main window, and only it is allowed to call the capability IPC.
const page = targets.find((target) => target.type === "page" && target.url.endsWith("index.html"));
if (!page) {
  console.error("no Emma window found");
  process.exit(1);
}

const socket = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();

const send = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });

socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(message.error.message));
  else waiter.resolve(message.result);
});

await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

const timer = setTimeout(() => {
  console.error(`timed out after ${timeout}ms`);
  process.exit(3);
}, timeout);

try {
  const result = await send("Runtime.evaluate", {
    expression: `(async () => { ${expression} })()`,
    awaitPromise: true,
    returnByValue: true,
    timeout,
  });
  if (result.exceptionDetails) {
    console.error("EXCEPTION:", JSON.stringify(result.exceptionDetails.exception?.description ?? result.exceptionDetails, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify(result.result.value, null, 2));
} finally {
  clearTimeout(timer);
  socket.close();
}
