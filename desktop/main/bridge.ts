import { Buffer } from "node:buffer";
import { createHash, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { WebSocketServer, WebSocket as PhoneSocket } from "ws";
import { BRIDGE_PORT, HANDSHAKE_BYTES, HEARTBEAT_MS, isBridgeMethod, MAX_FRAME_BYTES, PAIRING_TTL_MS, splitAddress } from "../shared/mobile-protocol";
import type { BridgeEvent, BridgeFrame, BridgeMethod, DesktopIdentity, LiveState, PairingPayload, PermissionAsk } from "../shared/mobile-protocol";
import { FrameCodec } from "./frames";
import { checkPin, clearPeers, loadPeers, MAX_PEERS, mintPeer, pairingPayload, savePeers, type Peer } from "./pairing";
import { addressesFor, pairingHost } from "./tailnet";

const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const GREET_LIVE_MS = 1_000;
/** How often the bridge re-resolves the host it pairs on, in case this Mac has moved. */
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
const MOVED = "This computer is no longer reachable at the address the phone was paired on. Pair the phone again.";
const TAKEN = `Another program on this computer is using port ${BRIDGE_PORT}.`;
const FULL = `Emma pairs ${MAX_PEERS} devices at a time. Remove one before pairing another.`;
/** How many dead keys are remembered, so a revoked phone stays refused across a restart. */
const MAX_REVOKED = 32;

const revokedFile = (userData: string) => path.join(userData, "mobile-revoked.json");
/** Only a hash is stored: enough to recognise a dead key, useless to anyone who reads the file. */
const digest = (token: string) => createHash("sha256").update(token).digest("hex");

function loadRevoked(userData: string): string[] {
  try {
    const stored: unknown = JSON.parse(readFileSync(revokedFile(userData), "utf8"));
    if (!Array.isArray(stored)) return [];
    return stored.filter((hash): hash is string => typeof hash === "string").slice(-MAX_REVOKED);
  } catch {
    return [];
  }
}

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
  /** Re-resolve the pairing host now, rather than waiting for the next poll. */
  recheck(): Promise<void>;
};

/** One address this Mac is serving the bridge on. */
type Bound = { server: WebSocketServer; up: boolean };

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
  // Keys this Mac has revoked, hashed and kept on disk, and refused at the door by
  // `known`. A revoked phone that was online was already told properly — `unpair` seals
  // a `bye` before it drops the codec — and one that was offline gets a bare close it
  // reads as "not now", backs off to thirty seconds, and explains from its own banner.
  // It used to be let in far enough to be shut with 4001 "revoked", but a close code is
  // the one thing on a ws:// link anyone on-path can write, and the phone believed it
  // hard enough to delete its pairing key: an unauthenticated instruction to forget your
  // Mac. Nothing can authenticate it before a handshake, so it is not sent at all.
  // Not constant-time on purpose — a dead key is worth nothing.
  let revoked = loadRevoked(deps.userData);
  const wasRevoked = (offered: string) => offered !== "" && revoked.includes(digest(offered));
  const revoke = (token: string) => {
    const hash = digest(token);
    if (revoked.includes(hash)) return;
    revoked = [...revoked, hash].slice(-MAX_REVOKED);
    try {
      mkdirSync(deps.userData, { recursive: true, mode: 0o700 });
      writeFileSync(revokedFile(deps.userData), `${JSON.stringify(revoked)}\n`, { encoding: "utf8", mode: 0o600 });
    } catch (error) {
      console.error("emma bridge: could not record the revoked key", error);
    }
  };

  let peers = loadPeers(deps.userData);
  let staged: Peer | undefined;
  // One server per address the pairing host points at, so the port is never open on a
  // network this Mac merely happens to have joined.
  const servers = new Map<string, Bound>();
  let retry: ReturnType<typeof setTimeout> | undefined;
  let guard: ReturnType<typeof setInterval> | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let backoff = BACKOFF_MIN_MS;
  let running = false;
  let listening = false;
  /** The addresses to serve; undefined until the pairing host has been resolved once. */
  let targets: string[] | undefined;
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

  /** True while an address the pairing host points at has no server on it yet. */
  const missing = (): boolean => (targets ?? []).some((address) => !servers.has(address));

  const anyUp = (): boolean => [...servers.values()].some((held) => held.up);

  const close = (server: WebSocketServer) => {
    try {
      server.close();
    } catch {
      /* already closing */
    }
  };

  const schedule = () => {
    if (!running || !bindAddr() || retry !== undefined || !missing()) return;
    const wait = backoff;
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    retry = setTimeout(() => {
      retry = undefined;
      reconcile();
    }, wait);
    retry.unref();
  };

  const open = (host: string, port: number) => {
    // Read live, not pinned at bind time: pairing a phone must not kick the others
    // off, and a revoked key has to stop opening the door the moment it is revoked.
    const known = (offered: string) => !wasRevoked(offered) && candidates().some((peer) => sameToken(offered, codecFor(peer).auth));
    let next: WebSocketServer;
    try {
      next = new WebSocketServer({
        host,
        port,
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
    const held: Bound = { server: next, up: false };
    servers.set(host, held);
    const mine = () => servers.get(host) === held;
    next.on("listening", () => {
      if (!mine()) return;
      held.up = true;
      backoff = BACKOFF_MIN_MS;
      listening = true;
      reason = "";
      changed();
    });
    next.on("error", (error) => {
      if (!mine()) return;
      console.error("emma bridge: could not listen on", host, error);
      servers.delete(host);
      listening = anyUp();
      reason = why(error);
      changed();
      close(next);
      schedule();
    });
    next.on("connection", (ws) => {
      // verifyClient already refused anything that did not offer a live key; this
      // finds which phone it was, so the session speaks that phone's codec.
      const peer = mine() ? candidates().find((peer) => sameToken(ws.protocol, codecFor(peer).auth)) : undefined;
      if (!peer) {
        ws.close(1011, "");
        return;
      }
      // One socket per phone: a rejoin replaces the socket it is replacing, and
      // leaves the other paired phones alone. The newcomer is not made to prove the
      // key first: a phone that suspends leaves a half-open socket the heartbeat only
      // notices a minute later, and proving it would need a codec per connection,
      // which is what remembers the handshakes already opened. All an auth token
      // alone buys is that reconnect flap — sealing and opening still need the key.
      const other = sessionOf(peer);
      if (other) drop(other[0], 1000);
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

  /** Serve exactly the addresses the pairing host points at right now, and nothing else. */
  const reconcile = () => {
    const addr = bindAddr();
    const where = addr ? splitAddress(addr) : undefined;
    if (!running || !where || !targets) return;
    for (const [address, held] of [...servers]) {
      if (targets.includes(address)) continue;
      servers.delete(address);
      close(held.server);
    }
    for (const address of targets) if (!servers.has(address)) open(address, where.port);
    listening = anyUp();
    changed();
  };

  /**
   * Re-resolve the host the phone dials, and serve wherever it points now. A Mac that
   * joins another network keeps its name, so its pairings survive the new address; only
   * a name that no longer answers to this Mac is a pairing the phone cannot use.
   */
  const refresh = async () => {
    const addr = bindAddr();
    if (!running || !addr) return;
    const where = splitAddress(addr);
    if (!where) return;
    const found = await addressesFor(where.host);
    // The pairing can be cancelled or replaced while the lookup is out.
    if (!running || bindAddr() !== addr) return;
    targets = found;
    if (!found.length) {
      if (reason === MOVED && !servers.size) return;
      reason = MOVED;
      shut();
      return;
    }
    if (reason === MOVED) reason = "";
    reconcile();
  };

  const watch = () => {
    if (guard !== undefined) return;
    guard = setInterval(() => void refresh(), WATCH_MS);
    guard.unref();
  };

  /** Serve while any key is live; once the last one goes, close the port. */
  const settle = () => {
    if (!candidates().length) {
      shut();
      return;
    }
    void refresh();
    changed();
  };

  const shut = () => {
    if (retry !== undefined) {
      clearTimeout(retry);
      retry = undefined;
    }
    targets = undefined;
    for (const ws of [...sessions.keys()]) drop(ws, 1000);
    const closing = [...servers.values()];
    servers.clear();
    listening = false;
    for (const held of closing) close(held.server);
    changed();
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
      void refresh();
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
      const host = await pairingHost();
      if (!host) throw new Error(NO_ADDRESS);
      const next = mintPeer(deps.identity.name, `ws://${host}:${BRIDGE_PORT}`, pin);
      unstage();
      staged = next;
      tries = 0;
      running = true;
      reason = "";
      // Not a rebind: the phones already paired keep their sockets through this.
      settle();
      watch();
      expiry = setTimeout(cancelPair, PAIRING_TTL_MS);
      expiry.unref();
      return await Promise.resolve(pairingPayload(next));
    },
    cancelPair,
    recheck: refresh,
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
        revoke(codecFor(peer).auth);
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
