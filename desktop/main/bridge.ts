import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket as PhoneSocket } from "ws";
import { BRIDGE_PORT, HANDSHAKE_BYTES, HEARTBEAT_MS, isBridgeMethod, MAX_FRAME_BYTES, PAIRING_TTL_MS, splitAddress } from "../shared/mobile-protocol";
import type { BridgeEvent, BridgeFrame, BridgeMethod, DesktopIdentity, LiveState, PairingPayload, PermissionAsk } from "../shared/mobile-protocol";
import { FrameCodec } from "./frames";
import { checkPin, clearPeers, loadPeers, MAX_PEERS, mintPeer, pairingPayload, savePeers, type Peer } from "./pairing";
import { hosts, preferredHost } from "./tailnet";

const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const GREET_LIVE_MS = 1_000;
/** How often the bridge re-checks that the address it pairs on is still on this Mac. */
const WATCH_MS = 15_000;
const MAX_ID_CHARS = 128;
const MAX_ERROR_CHARS = 200;
/** A staged pairing dies after this many wrong PINs, so the QR window is not a brute-force window. */
const MAX_PIN_TRIES = 5;
const UNKNOWN_METHOD = "Emma does not answer that request.";
const REQUEST_FAILED = "That request failed on this computer.";
const TOO_LARGE = "That answer is too large to send to the phone.";
const NEEDS_PIN = "Enter this computer's PIN on the phone to finish pairing.";
const BAD_PIN = "That PIN is wrong.";
const NO_ADDRESS = "This computer has no Tailscale or local network address to pair on.";
const NO_SAVE = "This computer could not save the pairing.";
const MOVED = "This computer's address changed, so the phone can no longer reach it. Pair the phone again.";
const TAKEN = `Another program on this computer is using port ${BRIDGE_PORT}.`;
const FULL = `Emma pairs ${MAX_PEERS} devices at a time. Remove one before pairing another.`;

export type BridgeDeps = {
  userData: string;
  identity: DesktopIdentity;
  dispatch: (method: BridgeMethod, params: Record<string, unknown>) => Promise<unknown>;
  live: () => LiveState;
  onStatus: (status: BridgeStatus) => void;
};

/** One paired phone. `id` is its pairing time, which is also how the renderer revokes it. */
export type BridgeDevice = { id: number; connected: boolean; lastSeen: number };

export type BridgeStatus = { devices: BridgeDevice[]; listening: boolean; pairing: boolean; full: boolean; reason: string; name: string; addr: string };

export type Bridge = {
  start(): void;
  stop(): void;
  sending(): boolean;
  event(event: BridgeEvent): void;
  ask(ask: PermissionAsk): boolean;
  resolved(id: string, allowed: boolean): void;
  status(): BridgeStatus;
  pair(pin: string): Promise<PairingPayload>;
  cancelPair(): void;
  unpair(id?: number): void;
};

/** Everything one connected phone owns. The codec is the peer's, not the socket's. */
type Session = { ws: PhoneSocket; peer: Peer; codec: FrameCodec; live: boolean; announced: number; beat?: ReturnType<typeof setInterval> };

function safeError(error: unknown): string {
  const raw = String((error as { message?: unknown } | null | undefined)?.message ?? error);
  const line = raw.split("\n", 1)[0].replace(/(?:\/[^\s:,;)\]"']+)+/g, "…").trim();
  return line.slice(0, MAX_ERROR_CHARS) || REQUEST_FAILED;
}

function requestParams(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** Every address a phone could dial this Mac on right now. */
function reachable(): string[] {
  const found = hosts();
  return [...found.tailnet, ...found.lan];
}

function why(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "EADDRINUSE") return TAKEN;
  if (code === "EADDRNOTAVAIL") return MOVED;
  return safeError(error);
}

/** Constant-time compare of the auth subprotocol the phone offered. */
function sameToken(offered: string, expected: string): boolean {
  const a = Buffer.from(offered);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createBridge(deps: BridgeDeps): Bridge {
  const pending = new Map<string, PermissionAsk>();
  const sessions = new Map<PhoneSocket, Session>();
  // One codec per peer, not per connection: it remembers the handshakes it has
  // already opened, which is what stops a recorded session being replayed.
  const codecs = new Map<number, FrameCodec>();
  const lastSeen = new Map<number, number>();

  let peers = loadPeers(deps.userData);
  let staged: Peer | undefined;
  let server: WebSocketServer | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let guard: ReturnType<typeof setInterval> | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let backoff = BACKOFF_MIN_MS;
  let running = false;
  let listening = false;
  let bound: string | undefined;
  let tries = 0;
  let reason = "";
  let reported = "";

  const codecFor = (peer: Peer): FrameCodec => {
    const held = codecs.get(peer.pairedAt);
    if (held) return held;
    const made = new FrameCodec(Buffer.from(peer.key, "base64url"), "mac");
    codecs.set(peer.pairedAt, made);
    return made;
  };

  /** Every key the door opens to right now: the paired phones, plus one being paired. */
  const candidates = (): Peer[] => (staged ? [...peers, staged] : peers);

  /** All phones share this Mac's one address, so the newest pairing sets the bind. */
  const bindAddr = (): string | undefined => staged?.addr ?? peers[0]?.addr;

  const sessionOf = (peer: Peer): [PhoneSocket, Session] | undefined => {
    for (const entry of sessions) if (entry[1].peer.pairedAt === peer.pairedAt) return entry;
    return undefined;
  };

  const devices = (): BridgeDevice[] => peers.map((peer) => ({
    id: peer.pairedAt,
    connected: sessionOf(peer)?.[1].live === true,
    lastSeen: lastSeen.get(peer.pairedAt) ?? 0,
  }));

  const status = (): BridgeStatus => ({
    devices: devices(),
    listening,
    pairing: staged !== undefined,
    full: peers.length >= MAX_PEERS,
    reason,
    name: deps.identity.name,
    addr: bindAddr() ?? "",
  });

  const changed = () => {
    const next = status();
    const stamp = JSON.stringify(next);
    if (stamp === reported) return;
    reported = stamp;
    deps.onStatus(next);
  };

  const to = (session: Session, frame: BridgeFrame): boolean => {
    // A phone that scanned the QR but has not proved the PIN gets answers to its
    // own requests and nothing else — no live state, no permission asks.
    if (frame.k === "evt" && !session.peer.verified) return false;
    if (!session.codec.ready) return false;
    // A session the socket map has moved on from must not seal on the peer's codec.
    if (sessions.get(session.ws) !== session || session.ws.readyState !== PhoneSocket.OPEN) return false;
    const sealed = session.codec.seal(frame);
    if (!sealed) return false;
    try {
      session.ws.send(sealed);
      return true;
    } catch {
      return false;
    }
  };

  const broadcast = (event: BridgeEvent): boolean => {
    let sent = false;
    for (const session of sessions.values()) if (to(session, event)) sent = true;
    return sent;
  };

  const sending = (): boolean => {
    for (const session of sessions.values()) if (session.peer.verified && session.codec.ready) return true;
    return false;
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

  const answer = (session: Session, id: string, run: Promise<unknown>) => {
    void run.then(
      (result) => {
        if (!to(session, { k: "res", id, ok: true, result } as BridgeFrame)) to(session, { k: "res", id, ok: false, error: TOO_LARGE });
      },
      (error: unknown) => {
        to(session, { k: "res", id, ok: false, error: safeError(error) });
      },
    ).catch(() => undefined);
  };

  const drop = (ws: PhoneSocket, code: number) => {
    try {
      ws.close(code, "");
    } catch (error) {
      console.error("emma bridge: peer close failed", error);
    }
    const session = sessions.get(ws);
    if (!session) return;
    sessions.delete(ws);
    if (session.beat !== undefined) clearInterval(session.beat);
    changed();
  };

  const unstage = () => {
    if (expiry === undefined) return;
    clearTimeout(expiry);
    expiry = undefined;
  };

  const commit = (): boolean => {
    if (!staged) return true;
    const next = [...peers, staged];
    try {
      savePeers(deps.userData, next);
    } catch (error) {
      console.error("emma bridge: could not save the paired phone", error);
      return false;
    }
    peers = next;
    staged = undefined;
    unstage();
    return true;
  };

  const cancelPair = () => {
    unstage();
    if (!staged) return;
    const entry = sessionOf(staged);
    codecs.delete(staged.pairedAt);
    staged = undefined;
    tries = 0;
    if (entry) drop(entry[0], 1000);
    settle();
  };

  const receive = (ws: PhoneSocket, data: Buffer, isBinary: boolean) => {
    const session = sessions.get(ws);
    if (!session) return;
    if (!isBinary) return; // the phone's text heartbeat
    if (data.byteLength === HANDSHAKE_BYTES) {
      if (!session.codec.greet(data)) return;
      try {
        ws.send(session.codec.hello);
      } catch {
        return;
      }
      const now = Date.now();
      if (!session.peer.verified || now - session.announced < GREET_LIVE_MS) return;
      session.announced = now;
      to(session, { k: "evt", t: "live", state: liveState() });
      return;
    }
    const frame = session.codec.open(data);
    if (!frame) return;
    lastSeen.set(session.peer.pairedAt, Date.now());
    const verified = session.peer.verified;
    if (verified && !session.live) {
      session.live = true;
      changed();
    }
    if (frame.k !== "req") return;
    const id: unknown = frame.id;
    if (typeof id !== "string" || !id || id.length > MAX_ID_CHARS) return;
    const params = requestParams(frame.params);
    if (!params || !isBridgeMethod(frame.method)) {
      to(session, { k: "res", id, ok: false, error: UNKNOWN_METHOD });
      return;
    }
    if (frame.method === "unlock") {
      if (!checkPin(session.peer.pin, params.pin)) {
        to(session, { k: "res", id, ok: false, error: BAD_PIN });
        // Only a pairing in flight can be spent; a phone already paired just retries.
        if (session.peer === staged && ++tries >= MAX_PIN_TRIES) {
          cancelPair();
          drop(ws, 1008);
        }
        return;
      }
      if (!session.peer.verified) {
        session.peer.verified = true;
        // A pairing that cannot reach the disk is not a pairing. Roll back rather
        // than leave the phone authorised against a record nothing will restore.
        if (!commit()) {
          session.peer.verified = false;
          to(session, { k: "res", id, ok: false, error: NO_SAVE });
          return;
        }
        session.live = true;
        changed();
      }
      tries = 0;
      to(session, { k: "res", id, ok: true, result: { unlocked: true } });
      to(session, { k: "evt", t: "live", state: liveState() });
      return;
    }
    if (!verified) {
      to(session, { k: "res", id, ok: false, error: NEEDS_PIN });
      return;
    }
    try {
      answer(session, id, deps.dispatch(frame.method, params));
    } catch (error) {
      to(session, { k: "res", id, ok: false, error: safeError(error) });
    }
  };

  const schedule = () => {
    if (!running || !bindAddr() || server || retry !== undefined) return;
    const wait = backoff;
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    retry = setTimeout(() => {
      retry = undefined;
      listen();
    }, wait);
    retry.unref();
  };

  const listen = () => {
    const addr = bindAddr();
    if (!running || !addr || server) return;
    const where = splitAddress(addr);
    if (!where) return;
    // The address is frozen at pair time. Once it is gone from this Mac the phone
    // cannot reach it either, so say so instead of retrying a bind that cannot work.
    if (!reachable().includes(where.host)) {
      reason = MOVED;
      changed();
      return;
    }
    // Read live, not pinned at bind time: pairing a phone must not kick the others
    // off, and a revoked key has to stop opening the door the moment it is revoked.
    const known = (offered: string) => candidates().some((peer) => sameToken(offered, codecFor(peer).auth));
    let next: WebSocketServer;
    try {
      // Bound to the pairing address only, so the port is never open on any other
      // network this Mac joins.
      next = new WebSocketServer({
        host: where.host,
        port: where.port,
        maxPayload: MAX_FRAME_BYTES,
        handleProtocols: (protocols) => {
          for (const offered of protocols) if (known(offered)) return offered;
          return false;
        },
        verifyClient: (info: { req: { headers: Record<string, string | string[] | undefined> } }) => {
          const offered = String(info.req.headers["sec-websocket-protocol"] ?? "").split(",").map((value) => value.trim());
          return offered.some(known);
        },
      });
    } catch (error) {
      reason = why(error);
      changed();
      schedule();
      return;
    }
    server = next;
    bound = addr;
    next.on("listening", () => {
      if (server !== next) return;
      backoff = BACKOFF_MIN_MS;
      listening = true;
      reason = "";
      changed();
    });
    next.on("error", (error) => {
      if (server !== next) return;
      console.error("emma bridge: could not listen on", addr, error);
      listening = false;
      server = undefined;
      reason = why(error);
      changed();
      try {
        next.close();
      } catch {
        /* already closing */
      }
      schedule();
    });
    next.on("connection", (ws) => {
      // verifyClient already refused anything that did not offer a live key; this
      // finds which phone it was, so the session speaks that phone's codec.
      const peer = server === next ? candidates().find((held) => sameToken(ws.protocol, codecFor(held).auth)) : undefined;
      if (!peer) {
        ws.close(1011, "");
        return;
      }
      // One socket per phone: a rejoin replaces the socket it is replacing, and
      // leaves the other paired phones alone.
      const held = sessionOf(peer);
      if (held) drop(held[0], 1000);
      const codec = codecFor(peer);
      codec.restart();
      const session: Session = { ws, peer, codec, live: false, announced: 0 };
      sessions.set(ws, session);
      ws.on("message", (data, isBinary) => receive(ws, data as Buffer, isBinary));
      ws.on("error", () => drop(ws, 1000));
      ws.on("close", () => drop(ws, 1000));
      // A phone that goes out of range or is suspended leaves a half-open socket
      // that never errors. Only an unanswered ping tells us it is gone; without it
      // `connected` stays true for hours and asks routed to the phone hang.
      let alive = true;
      ws.on("pong", () => { alive = true; });
      session.beat = setInterval(() => {
        if (sessions.get(ws) !== session || ws.readyState !== PhoneSocket.OPEN) return;
        if (!alive) {
          ws.terminate();
          drop(ws, 1000);
          return;
        }
        alive = false;
        try {
          ws.ping();
          ws.send("p");
        } catch {
          drop(ws, 1000);
        }
      }, HEARTBEAT_MS);
      session.beat.unref();
      changed();
    });
  };

  const watch = () => {
    if (guard !== undefined) return;
    guard = setInterval(() => {
      const addr = bindAddr();
      if (!running || !addr) return;
      const where = splitAddress(addr);
      if (!where) return;
      if (reachable().includes(where.host)) {
        if (reason !== MOVED) return;
        reason = "";
        relisten();
        return;
      }
      if (reason === MOVED && !server) return;
      reason = MOVED;
      shut();
    }, WATCH_MS);
    guard.unref();
  };

  /** Serve while any key is live; once the last one goes, close the port. */
  const settle = () => {
    if (!candidates().length) {
      shut();
      return;
    }
    if (bound !== bindAddr()) relisten();
    else if (!server) listen();
    changed();
  };

  const shut = () => {
    if (retry !== undefined) {
      clearTimeout(retry);
      retry = undefined;
    }
    bound = undefined;
    for (const ws of [...sessions.keys()]) drop(ws, 1000);
    const closing = server;
    server = undefined;
    listening = false;
    if (closing) {
      try {
        closing.close();
      } catch {
        /* already closing */
      }
    }
    changed();
  };

  const relisten = () => {
    shut();
    backoff = BACKOFF_MIN_MS;
    listen();
  };

  const farewell = (why: "revoked" | "shutdown") => {
    broadcast({ k: "evt", t: "bye", reason: why });
    unstage();
    shut();
  };

  return {
    start() {
      if (running) return;
      running = true;
      changed();
      listen();
      watch();
    },
    stop() {
      running = false;
      if (guard !== undefined) {
        clearInterval(guard);
        guard = undefined;
      }
      farewell("shutdown");
    },
    sending,
    event(event) {
      broadcast(event);
    },
    ask(ask) {
      if (peers.length) {
        const now = Date.now();
        for (const [id, held] of pending) if (held.expiresAt <= now) pending.delete(id);
        pending.set(ask.id, ask);
      }
      const sent = broadcast({ k: "evt", t: "permission-ask", ask });
      return sent && devices().some((device) => device.connected);
    },
    resolved(id, allowed) {
      pending.delete(id);
      broadcast({ k: "evt", t: "permission-resolved", id, allowed });
    },
    status,
    async pair(pin) {
      if (peers.length >= MAX_PEERS) throw new Error(FULL);
      const host = preferredHost();
      if (!host) throw new Error(NO_ADDRESS);
      const next = mintPeer(deps.identity.name, `ws://${host}:${BRIDGE_PORT}`, pin);
      unstage();
      staged = next;
      tries = 0;
      running = true;
      reason = "";
      // Not a relisten: the phones already paired keep their sockets through this.
      settle();
      watch();
      expiry = setTimeout(cancelPair, PAIRING_TTL_MS);
      expiry.unref();
      return await Promise.resolve(pairingPayload(next));
    },
    cancelPair,
    unpair(id) {
      const going = id === undefined ? [...peers] : peers.filter((peer) => peer.pairedAt === id);
      if (!going.length && id !== undefined) return;
      for (const peer of going) {
        const entry = sessionOf(peer);
        if (entry) {
          to(entry[1], { k: "evt", t: "bye", reason: "revoked" });
          // verifyClient only guards new sockets, so the one it is already holding
          // has to be shut or a revoked phone keeps asking on it.
          drop(entry[0], 1000);
        }
        codecs.delete(peer.pairedAt);
        lastSeen.delete(peer.pairedAt);
      }
      const keep = peers.filter((peer) => !going.some((gone) => gone.pairedAt === peer.pairedAt));
      try {
        if (keep.length) savePeers(deps.userData, keep);
        else clearPeers(deps.userData);
      } catch (error) {
        console.error("emma bridge: could not update the paired phones", error);
      }
      peers = keep;
      if (id === undefined) {
        unstage();
        if (staged) codecs.delete(staged.pairedAt);
        staged = undefined;
        pending.clear();
        tries = 0;
      }
      // verifyClient reads the live set, so the revoked key is already refused; the
      // port only closes once nothing is paired.
      settle();
    },
  };
}
