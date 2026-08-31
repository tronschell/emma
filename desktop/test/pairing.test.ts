import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bridgeAddress, BRIDGE_PORT, isPin, KEY_BYTES, PAIRING_TTL_MS, PROTOCOL_VERSION, splitAddress } from "../shared/mobile-protocol";
import type { Peer } from "../main/pairing";

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
const { checkPin, clearPeers, loadPeers, MAX_PEERS, mintPeer, pairingPayload, savePeers, sealPin }: typeof import("../main/pairing") = require("../main/pairing");

const userData = () => mkdtempSync(path.join(tmpdir(), "emma-pairing-"));
const ADDR = `ws://100.101.102.103:${BRIDGE_PORT}`;
const PIN = "482913";
const peerOf = (name: string) => mintPeer(name, ADDR, PIN);
/** What a pairing looks like once the phone has proved the PIN — the only kind that is ever saved. */
const provenPeer = (name: string): Peer => ({ ...peerOf(name), verified: true });

test("a minted peer carries a fresh key of the protocol's size, and a PIN nobody can read back", () => {
  const peer = peerOf("Tron's MacBook Pro");
  assert.equal(Buffer.from(peer.key, "base64url").length, KEY_BYTES);
  assert.match(peer.key, /^[A-Za-z0-9_-]+$/);
  assert.equal(peer.name, "Tron's MacBook Pro");
  assert.equal(peer.addr, ADDR);
  assert.equal(peer.verified, false, "a minted pairing counts as proved before the phone answers");
  assert.doesNotMatch(peer.pin, new RegExp(PIN));
  assert.ok(Math.abs(peer.pairedAt - Date.now()) < 5_000);
  assert.notEqual(peerOf("again").key, peer.key);
  assert.notEqual(peerOf("again").pin, peer.pin, "two pairings on the same PIN hash alike");
});

test("the pairing payload carries the address and expires two minutes out, and never the PIN", () => {
  const peer = peerOf("Tron's MacBook Pro");
  const payload = pairingPayload(peer);
  assert.equal(payload.v, PROTOCOL_VERSION);
  assert.equal(payload.addr, ADDR);
  assert.equal(payload.key, peer.key);
  assert.equal(payload.name, peer.name);
  assert.ok(Math.abs(payload.exp - (Date.now() + PAIRING_TTL_MS)) < 5_000);
  assert.doesNotMatch(JSON.stringify(payload), new RegExp(PIN));
  assert.equal("pin" in payload, false);
});

test("a sealed PIN answers only to itself", () => {
  const record = sealPin(PIN);
  assert.match(record, /^[0-9a-f]{32}:[0-9a-f]{64}$/);
  assert.equal(checkPin(record, PIN), true);
  assert.equal(checkPin(record, "482914"), false);
  assert.equal(checkPin(record, "48291"), false);
  assert.equal(checkPin(record, ""), false);
  assert.equal(checkPin(record, undefined), false);
  assert.equal(checkPin(record, `${PIN}\n`), false);
  assert.equal(checkPin("not-a-record", PIN), false);
  assert.throws(() => sealPin("12a4"), /4 to 12/);
  assert.throws(() => sealPin("123"), /4 to 12/);
});

test("a PIN is four to twelve digits, and nothing else", () => {
  assert.equal(isPin("1234"), true);
  assert.equal(isPin("123456789012"), true);
  assert.equal(isPin("123"), false);
  assert.equal(isPin("1234567890123"), false);
  assert.equal(isPin("12 34"), false);
  assert.equal(isPin("1234\n"), false, "a trailing newline slipped past the anchor");
  assert.equal(isPin("१२३४"), false);
  assert.equal(isPin(1234), false);
  assert.equal(isPin(undefined), false);
});

test("a bridge address is a host and port over ws, and nothing else", () => {
  assert.equal(bridgeAddress(ADDR), ADDR);
  assert.equal(bridgeAddress(`  ${ADDR}/  `), ADDR);
  assert.equal(bridgeAddress("wss://mac.tail1234.ts.net:47823"), "wss://mac.tail1234.ts.net:47823");
  assert.equal(bridgeAddress("ws://100.101.102.103"), "", "a portless address would leave the phone guessing");
  assert.equal(bridgeAddress(`${ADDR}/pair?role=mac`), "");
  assert.equal(bridgeAddress("http://100.101.102.103:47823"), "");
  assert.equal(bridgeAddress(`ws://${"a".repeat(300)}.example.com:47823`), "");
  assert.equal(bridgeAddress(undefined), "");
  assert.deepEqual(splitAddress(ADDR), { host: "100.101.102.103", port: BRIDGE_PORT });
  assert.equal(splitAddress("ws://100.101.102.103:0"), undefined);
  assert.equal(splitAddress("ws://100.101.102.103:70000"), undefined);
  assert.equal(splitAddress("not an address"), undefined);
});

test("a saved peer comes back whole, and the key never touches the disk in the clear", () => {
  const root = userData();
  const peer = provenPeer("Tron's MacBook Pro");
  savePeers(root, [peer]);
  assert.deepEqual(loadPeers(root), [peer]);
  const raw = readFileSync(path.join(root, "mobile-peers.json"), "utf8");
  assert.doesNotMatch(raw, new RegExp(peer.key.slice(0, 16)));
  assert.doesNotMatch(raw, new RegExp(PIN));
  assert.equal(existsSync(path.join(root, ".mobile-peers.tmp")), false);
});

test("a pairing the phone never proved does not survive a restart", () => {
  const root = userData();
  savePeers(root, [peerOf("Tron's MacBook Pro")]);
  assert.deepEqual(loadPeers(root), [], "an unproved pairing came back after a restart");
});

test("a corrupt, truncated, or unreadable record loads as undefined instead of throwing", () => {
  const root = userData();
  const file = path.join(root, "mobile-peers.json");
  assert.deepEqual(loadPeers(root), []);
  const peer = provenPeer("Tron's MacBook Pro");
  savePeers(root, [peer]);
  const whole = readFileSync(file, "utf8");
  writeFileSync(file, whole.slice(0, Math.floor(whole.length / 2)));
  assert.deepEqual(loadPeers(root), []);
  writeFileSync(file, "[]");
  assert.deepEqual(loadPeers(root), []);
  writeFileSync(file, JSON.stringify({ ...peer, key: Buffer.from(peer.key, "utf8").toString("base64") }));
  assert.deepEqual(loadPeers(root), []);
  writeFileSync(file, whole.replace(/"pairedAt": \d+/, '"pairedAt": "soon"'));
  assert.deepEqual(loadPeers(root), []);
  writeFileSync(file, whole.replace(ADDR, "https://100.101.102.103/pair"));
  assert.deepEqual(loadPeers(root), []);
  writeFileSync(file, whole.replace(peer.pin, "not-a-pin"));
  assert.deepEqual(loadPeers(root), [], "a record with no usable PIN would pair with no PIN at all");
});

test("minting without a usable address is refused", () => {
  assert.throws(() => mintPeer("Tron's MacBook Pro", "100.101.102.103", PIN), /address/);
  assert.throws(() => mintPeer("Tron's MacBook Pro", ADDR, "no"), /4 to 12/);
});

test("clearing an absent pairing is quiet, and a saved one goes away", () => {
  const root = userData();
  assert.doesNotThrow(() => clearPeers(root));
  savePeers(root, [provenPeer("Tron's MacBook Pro")]);
  clearPeers(root);
  assert.deepEqual(loadPeers(root), []);
  assert.doesNotThrow(() => clearPeers(root));
});

test("without a keychain the pairing is refused rather than written in plain text", () => {
  const root = userData();
  available = false;
  try {
    assert.throws(() => savePeers(root, [provenPeer("Tron's MacBook Pro")]), /plain text/);
  } finally {
    available = true;
  }
  assert.equal(existsSync(path.join(root, "mobile-peers.json")), false);
});

test("the one phone an older Emma paired is read back, and the old file is retired", () => {
  const root = userData();
  const peer = provenPeer("Tron's MacBook Pro");
  savePeers(root, [peer]);
  const written: unknown[] = JSON.parse(readFileSync(path.join(root, "mobile-peers.json"), "utf8"));
  // What the Emma before this one wrote: a lone object, not a list.
  writeFileSync(path.join(root, "mobile-peer.json"), JSON.stringify(written[0], null, 2));
  rmSync(path.join(root, "mobile-peers.json"));

  assert.deepEqual(loadPeers(root), [peer], "the phone paired before the upgrade was dropped");
  savePeers(root, loadPeers(root));
  assert.equal(existsSync(path.join(root, "mobile-peer.json")), false, "the old file outlived the upgrade");
  assert.deepEqual(loadPeers(root), [peer]);
});

test("a file holding more phones than Emma pairs is trimmed to the limit", () => {
  const root = userData();
  // Distinct pairing times: that is what tells two phones apart on disk.
  const peers = [0, 1, 2, 3].map((step) => ({ ...provenPeer(`phone ${step}`), pairedAt: Date.now() + step }));
  savePeers(root, peers);
  assert.equal(loadPeers(root).length, MAX_PEERS);
  assert.deepEqual(loadPeers(root), peers.slice(0, MAX_PEERS));
});
