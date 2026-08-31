import { safeStorage } from "electron";
import { Buffer } from "node:buffer";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { bridgeAddress, isPin, KEY_BYTES, PAIRING_TTL_MS, PROTOCOL_VERSION, type PairingPayload } from "../shared/mobile-protocol";

export type Peer = {
  key: string;
  name: string;
  addr: string;
  /** `<saltHex>:<hashHex>`. Never the PIN itself, and never sent to the phone. */
  pin: string;
  /** True once the phone has proved the PIN. A staged pairing is saved only after that. */
  verified: boolean;
  /**
   * Doubles as the device's id: a phone is paired by scanning a code and typing a
   * PIN, so no two finish in the same millisecond.
   * ponytail: give Peer its own id if pairing ever stops being hand-driven.
   */
  pairedAt: number;
};

/** How many phones one Mac pairs at once. A fourth is refused, never silently evicted. */
export const MAX_PEERS = 3;

const MAX_NAME_CHARS = 200;
const SALT_BYTES = 16;
const HASH_BYTES = 32;
const KEY = new RegExp(`^[A-Za-z0-9_-]{${Math.ceil((KEY_BYTES * 4) / 3)}}$`);
const PIN_RECORD = /^[0-9a-f]{32}:[0-9a-f]{64}$/;

const peersFile = (userData: string) => path.join(userData, "mobile-peers.json");
/** Emma paired one phone before it paired three; that file is read once and retired. */
const legacyFile = (userData: string) => path.join(userData, "mobile-peer.json");

function hashPin(pin: string, salt: Buffer): Buffer {
  return scryptSync(pin, salt, HASH_BYTES);
}

export function sealPin(pin: string): string {
  if (!isPin(pin)) throw new Error("A phone PIN is 4 to 12 digits.");
  const salt = randomBytes(SALT_BYTES);
  return `${salt.toString("hex")}:${hashPin(pin, salt).toString("hex")}`;
}

/** Constant-time check of a PIN against a sealed record. */
export function checkPin(record: string, pin: unknown): boolean {
  if (!PIN_RECORD.test(record) || !isPin(pin)) return false;
  const [salt, expected] = record.split(":");
  return timingSafeEqual(hashPin(pin, Buffer.from(salt, "hex")), Buffer.from(expected, "hex"));
}

export function mintPeer(name: string, addr: string, pin: string): Peer {
  const address = bridgeAddress(addr);
  if (!address) throw new Error("Emma needs an address to pair a phone on.");
  return {
    key: randomBytes(KEY_BYTES).toString("base64url"),
    name,
    addr: address,
    pin: sealPin(pin),
    verified: false,
    pairedAt: Date.now(),
  };
}

export function pairingPayload(peer: Peer): PairingPayload {
  return { v: PROTOCOL_VERSION, addr: peer.addr, key: peer.key, name: peer.name, exp: Date.now() + PAIRING_TTL_MS };
}

function decodePeer(stored: unknown): Peer | undefined {
  if (!stored || typeof stored !== "object") return undefined;
  const { key, name, addr, pin, verified, pairedAt } = stored as Record<string, unknown>;
  if (typeof key !== "string" || !key) return undefined;
  if (typeof name !== "string" || !name || name.length > MAX_NAME_CHARS) return undefined;
  if (typeof pin !== "string" || !PIN_RECORD.test(pin)) return undefined;
  if (verified !== true) return undefined;
  if (typeof pairedAt !== "number" || !Number.isFinite(pairedAt)) return undefined;
  const address = bridgeAddress(addr);
  if (!address) return undefined;
  const secret = safeStorage.decryptString(Buffer.from(key, "base64"));
  if (!KEY.test(secret)) return undefined;
  return { key: secret, name, addr: address, pin, verified: true, pairedAt };
}

function readPeers(raw: string): Peer[] {
  const stored: unknown = JSON.parse(raw);
  const list = Array.isArray(stored) ? stored : [stored];
  const peers: Peer[] = [];
  for (const entry of list) {
    const peer = decodePeer(entry);
    // One unreadable record does not cost the user the phones that still work.
    if (peer && !peers.some((held) => held.pairedAt === peer.pairedAt)) peers.push(peer);
  }
  return peers.slice(0, MAX_PEERS);
}

export function loadPeers(userData: string): Peer[] {
  for (const file of [peersFile(userData), legacyFile(userData)]) {
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    try {
      return readPeers(raw);
    } catch {
      console.error("Emma: the stored phone pairings could not be read; pair the phones again");
      return [];
    }
  }
  return [];
}

export function savePeers(userData: string, peers: readonly Peer[]): void {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("This Mac's keychain is unavailable, so Emma will not store the phone's pairing key in plain text.");
  const stored = peers.map((peer) => ({ ...peer, key: safeStorage.encryptString(peer.key).toString("base64") }));
  mkdirSync(userData, { recursive: true, mode: 0o700 });
  const temporary = path.join(userData, ".mobile-peers.tmp");
  writeFileSync(temporary, `${JSON.stringify(stored, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, peersFile(userData));
  rmSync(legacyFile(userData), { force: true });
}

export function clearPeers(userData: string): void {
  rmSync(peersFile(userData), { force: true });
  rmSync(legacyFile(userData), { force: true });
}
