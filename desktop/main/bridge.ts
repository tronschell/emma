import { Buffer } from "node:buffer";
import { HANDSHAKE_BYTES, HEARTBEAT_MS, isBridgeMethod, PAIRING_TTL_MS } from "../shared/mobile-protocol";
import type { BridgeEvent, BridgeFrame, BridgeMethod, DesktopIdentity, LiveState, PairingPayload, PermissionAsk } from "../shared/mobile-protocol";
import { FrameCodec } from "./frames";
import { clearPeer, loadPeer, mintPeer, pairingPayload, savePeer, type Peer } from "./pairing";

const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const CLAIM_TIMEOUT_MS = 10_000;
const GREET_LIVE_MS = 1_000;
const MAX_ID_CHARS = 128;
const MAX_ERROR_CHARS = 200;
const PEER_GONE = "-";
const UNKNOWN_METHOD = "Emma does not answer that request.";
const REQUEST_FAILED = "That request failed on this computer.";
const TOO_LARGE = "That answer is too large to send to the phone.";
const NO_RELAY = "This computer could not reach the pairing relay.";

export type BridgeDeps = {
  userData: string;
  identity: DesktopIdentity;
  dispatch: (method: BridgeMethod, params: Record<string, unknown>) => Promise<unknown>;
  live: () => LiveState;
  onStatus: (status: BridgeStatus) => void;
};

export type BridgeStatus = { paired: boolean; connected: boolean; name: string; lastSeen: number };

export type Bridge = {
  start(): void;
  stop(): void;
  sending(): boolean;
  event(event: BridgeEvent): void;
  ask(ask: PermissionAsk): boolean;
  resolved(id: string, allowed: boolean): void;
  status(): BridgeStatus;
  pair(relay: string): Promise<PairingPayload>;
  cancelPair(): void;
  unpair(): void;
};

function safeError(error: unknown): string {
  const raw = String((error as { message?: unknown } | null | undefined)?.message ?? error);
  const line = raw.split("\n", 1)[0].replace(/(?:\/[^\s:,;)\]"']+)+/g, "…").trim();
  return line.slice(0, MAX_ERROR_CHARS) || REQUEST_FAILED;
}

function requestParams(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export function createBridge(deps: BridgeDeps): Bridge {
  const pending = new Map<string, PermissionAsk>();
  const codecFor = (value: Peer) => new FrameCodec(Buffer.from(value.key, "base64url"), "mac");

  let saved = loadPeer(deps.userData);
  let staged: Peer | undefined;
  let peer = saved;
  let codec = peer ? codecFor(peer) : undefined;
  let socket: WebSocket | undefined;
  let beat: ReturnType<typeof setInterval> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let claim: { settle: (error?: Error) => void } | undefined;
  let backoff = BACKOFF_MIN_MS;
  let running = false;
  let phone = false;
  let announced = 0;
  let lastSeen = 0;
  let reported: BridgeStatus = { paired: false, connected: false, name: "", lastSeen: 0 };

  const status = (): BridgeStatus => ({ paired: saved !== undefined, connected: phone, name: peer?.name ?? "", lastSeen });

  const changed = () => {
    const next = status();
    if (next.paired === reported.paired && next.connected === reported.connected && next.name === reported.name) return;
    reported = next;
    deps.onStatus(next);
  };

  const sending = (): boolean => phone && codec !== undefined && codec.ready && socket !== undefined && socket.readyState === WebSocket.OPEN;

  const send = (frame: BridgeFrame): boolean => {
    if (!codec || !codec.ready || !socket || socket.readyState !== WebSocket.OPEN) return false;
    const sealed = codec.seal(frame);
    if (!sealed) return false;
    try {
      socket.send(sealed as Uint8Array<ArrayBuffer>);
      return true;
    } catch {
      return false;
    }
  };

  const liveState = (): LiveState => {
    const state = deps.live();
    const now = Date.now();
    const asks = new Map(state.asks.map((ask) => [ask.id, ask]));
    for (const [id, ask] of pending) {
      if (ask.expiresAt <= now) pending.delete(id);
      else if (!asks.has(id)) asks.set(id, ask);
    }
    return { ...state, asks: [...asks.values()].filter((ask) => ask.expiresAt > now) };
  };

  const answer = (id: string, run: Promise<unknown>) => {
    void run.then(
      (result) => {
        if (!send({ k: "res", id, ok: true, result } as BridgeFrame)) send({ k: "res", id, ok: false, error: TOO_LARGE });
      },
      (error: unknown) => {
        send({ k: "res", id, ok: false, error: safeError(error) });
      },
    ).catch(() => undefined);
  };

  const drop = (ws: WebSocket, code: number) => {
    try {
      ws.close(code, "");
    } catch (error) {
      console.error("emma bridge: peer close failed", error);
    }
    if (socket !== ws) return;
    socket = undefined;
    phone = false;
    if (beat !== undefined) {
      clearInterval(beat);
      beat = undefined;
    }
    claim?.settle(new Error(NO_RELAY));
    changed();
  };

  const schedule = () => {
    if (!running || !peer || socket || retry !== undefined) return;
    const wait = backoff;
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    retry = setTimeout(() => {
      retry = undefined;
      connect();
    }, wait);
  };

  const unstage = () => {
    if (expiry === undefined) return;
    clearTimeout(expiry);
    expiry = undefined;
  };

  const commit = () => {
    if (!staged) return;
    try {
      savePeer(deps.userData, staged);
    } catch (error) {
      console.error("emma bridge: could not save the paired phone", error);
      return;
    }
    saved = staged;
    staged = undefined;
    unstage();
  };

  const cancelPair = () => {
    unstage();
    if (!staged) return;
    staged = undefined;
    peer = saved;
    codec = peer ? codecFor(peer) : undefined;
    phone = false;
    changed();
    reconnect();
  };

  const receive = (ws: WebSocket, data: unknown) => {
    if (!codec || socket !== ws) return;
    if (typeof data === "string") {
      if (data === PEER_GONE && phone) {
        phone = false;
        changed();
      }
      return;
    }
    if (!(data instanceof ArrayBuffer) && !(data instanceof Uint8Array)) return;
    if (data.byteLength === HANDSHAKE_BYTES) {
      if (!codec.greet(data)) return;
      try {
        ws.send(codec.hello as Uint8Array<ArrayBuffer>);
      } catch {
        return;
      }
      const now = Date.now();
      if (now - announced < GREET_LIVE_MS) return;
      announced = now;
      send({ k: "evt", t: "live", state: liveState() });
      return;
    }
    const frame = codec.open(data);
    if (!frame) return;
    lastSeen = Date.now();
    if (!phone) {
      phone = true;
      commit();
      changed();
    }
    if (frame.k !== "req") return;
    const id: unknown = frame.id;
    if (typeof id !== "string" || !id || id.length > MAX_ID_CHARS) return;
    const params = requestParams(frame.params);
    if (!params || !isBridgeMethod(frame.method)) {
      send({ k: "res", id, ok: false, error: UNKNOWN_METHOD });
      return;
    }
    try {
      answer(id, deps.dispatch(frame.method, params));
    } catch (error) {
      send({ k: "res", id, ok: false, error: safeError(error) });
    }
  };

  const connect = () => {
    if (!running || !peer || !codec || socket) return;
    const hello = codec.restart();
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${peer.relay}/${peer.room}?role=mac`, [codec.auth]);
    } catch {
      schedule();
      return;
    }
    ws.binaryType = "arraybuffer";
    socket = ws;
    phone = false;
    announced = 0;
    ws.onopen = () => {
      if (socket !== ws) return;
      backoff = BACKOFF_MIN_MS;
      claim?.settle();
      try {
        ws.send(hello as Uint8Array<ArrayBuffer>);
      } catch {
        drop(ws, 1000);
        schedule();
        return;
      }
      beat = setInterval(() => {
        if (socket !== ws || ws.readyState !== WebSocket.OPEN) return;
        try {
          ws.send("p");
        } catch {
          drop(ws, 1000);
        }
      }, HEARTBEAT_MS);
    };
    ws.onmessage = (message) => receive(ws, message.data);
    ws.onerror = () => {
      drop(ws, 1000);
      schedule();
    };
    ws.onclose = () => {
      drop(ws, 1000);
      schedule();
    };
  };

  const reconnect = () => {
    if (retry !== undefined) {
      clearTimeout(retry);
      retry = undefined;
    }
    if (socket) drop(socket, 1000);
    backoff = BACKOFF_MIN_MS;
    connect();
  };

  const farewell = (reason: "revoked" | "shutdown") => {
    send({ k: "evt", t: "bye", reason });
    unstage();
    if (retry !== undefined) {
      clearTimeout(retry);
      retry = undefined;
    }
    if (socket) drop(socket, 1000);
  };

  return {
    start() {
      if (running) return;
      running = true;
      changed();
      connect();
    },
    stop() {
      running = false;
      farewell("shutdown");
    },
    sending,
    event(event) {
      send(event);
    },
    ask(ask) {
      if (peer) {
        const now = Date.now();
        for (const [id, held] of pending) if (held.expiresAt <= now) pending.delete(id);
        pending.set(ask.id, ask);
      }
      return send({ k: "evt", t: "permission-ask", ask }) && phone;
    },
    resolved(id, allowed) {
      pending.delete(id);
      send({ k: "evt", t: "permission-resolved", id, allowed });
    },
    status,
    async pair(relay) {
      const next = mintPeer(deps.identity.name, relay);
      unstage();
      staged = next;
      peer = next;
      codec = codecFor(next);
      running = true;
      changed();
      reconnect();
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => claim?.settle(new Error(NO_RELAY)), CLAIM_TIMEOUT_MS);
          claim = {
            settle: (error) => {
              if (!claim) return;
              claim = undefined;
              clearTimeout(timer);
              if (error) reject(error);
              else resolve();
            },
          };
        });
      } catch (error) {
        cancelPair();
        throw error;
      }
      expiry = setTimeout(cancelPair, PAIRING_TTL_MS);
      expiry.unref();
      return pairingPayload(next);
    },
    cancelPair,
    unpair() {
      farewell("revoked");
      clearPeer(deps.userData);
      pending.clear();
      saved = undefined;
      staged = undefined;
      peer = undefined;
      codec = undefined;
      lastSeen = 0;
      changed();
    },
  };
}
