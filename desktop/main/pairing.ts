import { safeStorage } from "electron";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { KEY_BYTES, PAIRING_TTL_MS, PROTOCOL_VERSION, relayOrigin, ROOM_BYTES, type PairingPayload } from "../shared/mobile-protocol";

export type Peer = { room: string; key: string; name: string; relay: string; pairedAt: number };

const MAX_NAME_CHARS = 200;
const ROOM = new RegExp(`^[0-9a-f]{${ROOM_BYTES * 2}}$`);
const KEY = new RegExp(`^[A-Za-z0-9_-]{${Math.ceil((KEY_BYTES * 4) / 3)}}$`);

const peerFile = (userData: string) => path.join(userData, "mobile-peer.json");

export function mintPeer(name: string, relay: string): Peer {
  const origin = relayOrigin(relay);
  if (!origin) throw new Error("Emma needs the address of a relay to pair a phone through.");
  return {
    room: randomBytes(ROOM_BYTES).toString("hex"),
    key: randomBytes(KEY_BYTES).toString("base64url"),
    name,
    relay: origin,
    pairedAt: Date.now(),
  };
}

export function pairingPayload(peer: Peer): PairingPayload {
  return { v: PROTOCOL_VERSION, relay: peer.relay, room: peer.room, key: peer.key, name: peer.name, exp: Date.now() + PAIRING_TTL_MS };
}

function decodePeer(raw: string): Peer | undefined {
  const stored: unknown = JSON.parse(raw);
  if (!stored || typeof stored !== "object") return undefined;
  const { room, key, name, relay, pairedAt } = stored as Record<string, unknown>;
  if (typeof room !== "string" || !ROOM.test(room)) return undefined;
  if (typeof key !== "string" || !key) return undefined;
  if (typeof name !== "string" || !name || name.length > MAX_NAME_CHARS) return undefined;
  if (typeof pairedAt !== "number" || !Number.isFinite(pairedAt)) return undefined;
  const origin = relayOrigin(relay);
  if (!origin) return undefined;
  const secret = safeStorage.decryptString(Buffer.from(key, "base64"));
  if (!KEY.test(secret)) return undefined;
  return { room, key: secret, name, relay: origin, pairedAt };
}

export function loadPeer(userData: string): Peer | undefined {
  let raw: string;
  try {
    raw = readFileSync(peerFile(userData), "utf8");
  } catch {
    return undefined;
  }
  try {
    return decodePeer(raw);
  } catch {
    console.error("Emma: the stored phone pairing could not be read; pair the phone again");
    return undefined;
  }
}

export function savePeer(userData: string, peer: Peer): void {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("This Mac's keychain is unavailable, so Emma will not store the phone's pairing key in plain text.");
  const stored = { ...peer, key: safeStorage.encryptString(peer.key).toString("base64") };
  mkdirSync(userData, { recursive: true, mode: 0o700 });
  const temporary = path.join(userData, ".mobile-peer.tmp");
  writeFileSync(temporary, `${JSON.stringify(stored, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, peerFile(userData));
}

export function clearPeer(userData: string): void {
  rmSync(peerFile(userData), { force: true });
}
