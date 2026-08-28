import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { KEY_BYTES, PAIRING_TTL_MS, PROTOCOL_VERSION, relayOrigin, ROOM_BYTES } from "../shared/mobile-protocol";

const SEAL = "keychain:";
let available = true;
const electron = {
  safeStorage: {
    isEncryptionAvailable: () => available,
    encryptString: (value: string) => Buffer.from(`${SEAL}${value}`, "utf8"),
    decryptString: (value: Buffer) => {
      const text = value.toString("utf8");
      if (!text.startsWith(SEAL)) throw new Error("this ciphertext is not ours");
      return text.slice(SEAL.length);
    },
  },
};
const electronPath = require.resolve("electron");
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: electron } as unknown as NodeModule;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { clearPeer, loadPeer, mintPeer, pairingPayload, savePeer }: typeof import("../main/pairing") = require("../main/pairing");

const userData = () => mkdtempSync(path.join(tmpdir(), "emma-pairing-"));
const RELAY = "wss://emma-relay.emma-dev.workers.dev";
const peerOf = (name: string) => mintPeer(name, RELAY);

test("a minted peer carries a fresh room and key of the protocol's sizes", () => {
  const peer = peerOf("Tron's MacBook Pro");
  assert.equal(peer.room.length, ROOM_BYTES * 2);
  assert.match(peer.room, /^[0-9a-f]+$/);
  assert.equal(Buffer.from(peer.key, "base64url").length, KEY_BYTES);
  assert.match(peer.key, /^[A-Za-z0-9_-]+$/);
  assert.equal(peer.name, "Tron's MacBook Pro");
  assert.equal(peer.relay, RELAY);
  assert.ok(Math.abs(peer.pairedAt - Date.now()) < 5_000);
  assert.notEqual(peerOf("again").room, peer.room);
  assert.notEqual(peerOf("again").key, peer.key);
});

test("the pairing payload carries the relay and expires two minutes out", () => {
  const peer = peerOf("Tron's MacBook Pro");
  const payload = pairingPayload(peer);
  assert.equal(payload.v, PROTOCOL_VERSION);
  assert.equal(payload.relay, RELAY);
  assert.equal(payload.room, peer.room);
  assert.equal(payload.key, peer.key);
  assert.equal(payload.name, peer.name);
  assert.ok(Math.abs(payload.exp - (Date.now() + PAIRING_TTL_MS)) < 5_000);
});

test("a saved peer comes back whole, and the key never touches the disk in the clear", () => {
  const root = userData();
  const peer = peerOf("Tron's MacBook Pro");
  savePeer(root, peer);
  assert.deepEqual(loadPeer(root), peer);
  const raw = readFileSync(path.join(root, "mobile-peer.json"), "utf8");
  assert.doesNotMatch(raw, new RegExp(peer.key.slice(0, 16)));
  assert.match(raw, new RegExp(peer.room));
  assert.equal(existsSync(path.join(root, ".mobile-peer.tmp")), false);
});

test("a corrupt, truncated, or unreadable record loads as undefined instead of throwing", () => {
  const root = userData();
  const file = path.join(root, "mobile-peer.json");
  assert.equal(loadPeer(root), undefined);
  const peer = peerOf("Tron's MacBook Pro");
  savePeer(root, peer);
  const whole = readFileSync(file, "utf8");
  writeFileSync(file, whole.slice(0, Math.floor(whole.length / 2)));
  assert.equal(loadPeer(root), undefined);
  writeFileSync(file, "[]");
  assert.equal(loadPeer(root), undefined);
  writeFileSync(file, JSON.stringify({ ...peer, key: Buffer.from(peer.key, "utf8").toString("base64") }));
  assert.equal(loadPeer(root), undefined);
  writeFileSync(file, whole.replace(peer.room, "not-a-room"));
  assert.equal(loadPeer(root), undefined);
  writeFileSync(file, whole.replace(/"pairedAt": \d+/, '"pairedAt": "soon"'));
  assert.equal(loadPeer(root), undefined);
  writeFileSync(file, whole.replace(RELAY, "https://emma-relay.example.com/pair"));
  assert.equal(loadPeer(root), undefined);
});

test("a relay address is an origin over wss, or loopback, and nothing else", () => {
  assert.equal(relayOrigin("wss://emma-relay.emma-dev.workers.dev/"), RELAY);
  assert.equal(relayOrigin("  wss://emma-relay.emma-dev.workers.dev  "), RELAY);
  assert.equal(relayOrigin("ws://127.0.0.1:8787"), "ws://127.0.0.1:8787");
  assert.equal(relayOrigin("wss://relay.example.com/room?role=mac"), "");
  assert.equal(relayOrigin("https://relay.example.com"), "");
  assert.equal(relayOrigin("ws://relay.example.com"), "");
  assert.equal(relayOrigin(`wss://${"a".repeat(300)}.example.com`), "");
  assert.equal(relayOrigin(undefined), "");
});

test("minting without a usable relay is refused", () => {
  assert.throws(() => mintPeer("Tron's MacBook Pro", "relay.example.com"), /relay/);
});

test("clearing an absent pairing is quiet, and a saved one goes away", () => {
  const root = userData();
  assert.doesNotThrow(() => clearPeer(root));
  savePeer(root, peerOf("Tron's MacBook Pro"));
  clearPeer(root);
  assert.equal(loadPeer(root), undefined);
  assert.doesNotThrow(() => clearPeer(root));
});

test("without a keychain the pairing is refused rather than written in plain text", () => {
  const root = userData();
  available = false;
  try {
    assert.throws(() => savePeer(root, peerOf("Tron's MacBook Pro")), /plain text/);
  } finally {
    available = true;
  }
  assert.equal(existsSync(path.join(root, "mobile-peer.json")), false);
});
