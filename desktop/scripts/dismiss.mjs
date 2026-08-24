// Dev-only: mark the first-launch import dialog as seen in the dev profile, then reload.
const port = process.argv[2] ?? "9223";
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === "page" && !t.url.includes("?"));
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve) => socket.addEventListener("open", resolve));
let id = 0;
const send = (method, params = {}) => new Promise((resolve) => {
  const mine = ++id;
  const listener = (event) => {
    const message = JSON.parse(event.data);
    if (message.id === mine) { socket.removeEventListener("message", listener); resolve(message.result); }
  };
  socket.addEventListener("message", listener);
  socket.send(JSON.stringify({ id: mine, method, params }));
});
await send("Runtime.enable");
await send("Runtime.evaluate", { expression: `localStorage.setItem("emma.importsSeen.v1", "1"), location.reload(), true` });
await new Promise((resolve) => setTimeout(resolve, 2500));
console.log("dismissed");
socket.close();
