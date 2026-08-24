import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import type { BrowserStatus } from "./types";
import { parseStreamMessage } from "./browser-stream";

const INSTALL_COMMAND = "npm install -g agent-browser && agent-browser install";
const MAX_FPS = 10;
const MOVE_MS = 40;
const BUTTONS = ["left", "middle", "right"] as const;

export function BrowserPane({ threadId }: { threadId: string }) {
  const [known, setKnown] = useState<{ threadId: string; status: BrowserStatus }>();
  const [typed, setTyped] = useState<{ threadId: string; url: string }>();
  const [live, setLive] = useState(false);
  const [copied, setCopied] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const socket = useRef<WebSocket | null>(null);
  const showing = useRef(threadId);
  const moved = useRef(0);

  useEffect(() => {
    showing.current = threadId;
    let alive = true;
    const take = (status: BrowserStatus) => { if (alive) setKnown({ threadId, status }); };
    const read = () => void window.emma.browserStatus(threadId)
      .then(take)
      .catch(() => take({ installed: false, running: false }));
    read();
    const stop = window.emma.onBrowser(read);
    return () => { alive = false; stop(); };
  }, [threadId]);

  const status = known?.threadId === threadId ? known.status : undefined;
  const installed = status?.installed ?? false;
  const running = status?.running ?? false;

  useEffect(() => {
    if (!installed || !running) return;
    let alive = true;
    let stream: WebSocket | undefined;
    const image = new Image();
    image.onload = () => {
      const target = canvas.current;
      const context = target?.getContext("2d");
      if (!target || !context) return;
      if (target.width !== image.naturalWidth || target.height !== image.naturalHeight) {
        target.width = image.naturalWidth;
        target.height = image.naturalHeight;
      }
      context.drawImage(image, 0, 0);
    };
    void window.emma.browserStream(threadId).then(({ port }) => {
      if (!alive) return;
      const open = new WebSocket(`ws://127.0.0.1:${port}/?pacing=ack&maxFps=${MAX_FPS}`);
      stream = open;
      socket.current = open;
      open.onopen = () => setLive(true);
      open.onclose = () => setLive(false);
      open.onerror = () => setLive(false);
      open.onmessage = (event: MessageEvent<unknown>) => {
        const message = parseStreamMessage(event.data);
        if (!message) return;
        if (message.kind === "page") {
          const seen = message.url;
          setKnown((last) => last?.threadId === threadId && last.status.url !== seen ? { threadId, status: { ...last.status, url: seen } } : last);
          return;
        }
        if (message.seq !== undefined) open.send(JSON.stringify({ type: "ack", seq: message.seq }));
        image.src = `data:image/jpeg;base64,${message.data}`;
      };
    }).catch(() => undefined);
    return () => {
      alive = false;
      image.onload = null;
      stream?.close();
      socket.current = null;
      setLive(false);
    };
  }, [threadId, installed, running]);

  const send = (message: Record<string, unknown>) => {
    const stream = socket.current;
    if (stream?.readyState === WebSocket.OPEN) stream.send(JSON.stringify(message));
  };

  const at = (event: ReactPointerEvent<HTMLCanvasElement> | ReactWheelEvent<HTMLCanvasElement>) => {
    const target = event.currentTarget;
    const rect = target.getBoundingClientRect();
    if (!rect.width || !rect.height) return { x: 0, y: 0 };
    return {
      x: Math.round((event.clientX - rect.left) * target.width / rect.width),
      y: Math.round((event.clientY - rect.top) * target.height / rect.height),
    };
  };

  const mouse = (eventType: "mousePressed" | "mouseReleased", event: ReactPointerEvent<HTMLCanvasElement>) =>
    send({ type: "input_mouse", eventType, ...at(event), button: BUTTONS[event.button] ?? "left", clickCount: event.detail || 1 });

  const key = (eventType: "keyDown" | "keyUp", event: ReactKeyboardEvent<HTMLCanvasElement>) => {
    if (event.key === "Tab" || event.metaKey || event.ctrlKey) return;
    if (event.key !== "Escape") event.preventDefault();
    const text = event.key.length === 1 ? event.key : undefined;
    send({ type: "input_keyboard", eventType, key: event.key, ...(text && eventType === "keyDown" ? { text } : {}) });
  };

  const apply = (next: BrowserStatus) => { if (showing.current === threadId) setKnown({ threadId, status: next }); };

  const nav = (action: "back" | "forward" | "reload") =>
    void window.emma.browserNav({ threadId, action }).then(apply).catch(() => undefined);

  const draft = typed?.threadId === threadId ? typed.url : undefined;

  const go = () => {
    const wanted = (draft ?? status?.url ?? "").trim();
    if (!wanted) return;
    setTyped(undefined);
    const url = /^[a-z][a-z0-9+.-]*:/i.test(wanted) ? wanted : `https://${wanted}`;
    void window.emma.browserOpen({ threadId, url }).then(apply).catch(() => undefined);
  };

  if (!status) return <section className="browser-pane" aria-label="Browser" />;

  if (!installed) return <section className="browser-pane" aria-label="Browser">
    <div className="browser-install">
      <span>Not installed</span>
      <code>{INSTALL_COMMAND}</code>
      <button type="button" onClick={() => void navigator.clipboard.writeText(INSTALL_COMMAND).then(() => setCopied(true)).catch(() => undefined)}>{copied ? "Copied" : "Copy"}</button>
    </div>
  </section>;

  return <section className="browser-pane" aria-label="Browser">
    <header className="browser-bar">
      <button type="button" aria-label="Back" title="Back" disabled={!running} onClick={() => nav("back")}>←</button>
      <button type="button" aria-label="Forward" title="Forward" disabled={!running} onClick={() => nav("forward")}>→</button>
      <button type="button" aria-label="Reload" title="Reload" disabled={!running} onClick={() => nav("reload")}>↺</button>
      <input className="browser-url" aria-label="Address" value={draft ?? status.url ?? ""} spellCheck={false} autoComplete="off" placeholder="Open a page" enterKeyHint="go"
        onChange={(event) => setTyped({ threadId, url: event.target.value })}
        onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); go(); }
          if (event.key === "Escape") setTyped(undefined);
        }} />
      <i className="browser-live" data-live={live} title={live ? "Streaming" : "Not streaming"} aria-hidden="true" />
    </header>
    <div className="browser-stage" data-idle={!live}>
      <canvas ref={canvas} tabIndex={0} role="img" aria-label="Live browser view"
        onPointerDown={(event) => { event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); mouse("mousePressed", event); }}
        onPointerUp={(event) => mouse("mouseReleased", event)}
        onPointerMove={(event) => {
          if (event.timeStamp - moved.current < MOVE_MS) return;
          moved.current = event.timeStamp;
          send({ type: "input_mouse", eventType: "mouseMoved", ...at(event), button: "none" });
        }}
        onWheel={(event) => send({ type: "input_mouse", eventType: "mouseWheel", ...at(event), button: "none", deltaX: Math.round(event.deltaX), deltaY: Math.round(event.deltaY) })}
        onContextMenu={(event) => event.preventDefault()}
        onKeyDown={(event) => key("keyDown", event)}
        onKeyUp={(event) => key("keyUp", event)} />
    </div>
  </section>;
}
