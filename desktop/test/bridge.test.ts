import test, { mock, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { FrameCodec } from "../main/frames";
import { BRIDGE_PORT, HANDSHAKE_BYTES, MAX_ASK_MS, PAIRING_TTL_MS } from "../shared/mobile-protocol";
import type { BridgeStatus } from "../main/bridge";
import type { BridgeFrame, DesktopIdentity, LiveState, PairingPayload, PermissionAsk } from "../shared/mobile-protocol";

const SEAL = "keychain:";
const electron = {
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`${SEAL}${value}`, "utf8"),
    decryptString: (value: Buffer) => value.toString("utf8").slice(SEAL.length),
  },
};
const electronPath = require.resolve("electron");
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: electron } as unknown as NodeModule;

// Bind the tests to loopback rather than whatever this machine's Tailscale or LAN address is.
const tailnetPath = require.resolve("../main/tailnet");
require.cache[tailnetPath] = {
  id: tailnetPath,
  filename: tailnetPath,
  loaded: true,
  exports: { preferredHost: () => "127.0.0.1", hosts: () => ({ tailnet: [], lan: ["127.0.0.1"] }), isTailnet: () => false },
} as unknown as NodeModule;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createBridge }: typeof import("../main/bridge") = require("../main/bridge");

const PIN = "482913";
const identity: DesktopIdentity = { id: "mac", name: "Test Mac", version: "0.0.0", protocol: 1 };
const idle = (): LiveState => ({ agents: [], spans: {}, asks: [], partial: {}, desktop: identity });
const asking = (id: string): PermissionAsk => ({
  id,
  threadId: "t1",
  tool: "edit",
  summary: "Emma wants to edit a file",
  detail: "d".repeat(4096),
  askedAt: Date.now(),
  expiresAt: Date.now() + MAX_ASK_MS,
});

type Harness = ReturnType<typeof createBridge> & { listened: Promise<void> };

function bridgeOn(t: TestContext, live: () => LiveState = idle, dispatch: () => Promise<unknown> = () => Promise.resolve({})): Harness {
  let ready: () => void;
  // A fixed port means a leftover process wedges the whole suite. Say so instead of hanging.
  const listened = new Promise<void>((resolve, reject) => {
    ready = resolve;
    const late = setTimeout(() => reject(new Error(`nothing is listening on 127.0.0.1:${BRIDGE_PORT} — is another test process still holding it?`)), 5_000);
    late.unref();
  });
  const bridge = createBridge({
    userData: mkdtempSync(path.join(tmpdir(), "emma-bridge-")),
    identity,
    dispatch,
    live,
    onStatus: (status: BridgeStatus) => { if (status.listening) ready(); },
  });
  // Tests that never await it (the fake-timer one) must not raise unhandled rejections.
  listened.catch(() => undefined);
  // Without this a failed assertion leaves the port bound and hangs the runner.
  t.after(() => bridge.stop());
  return Object.assign(bridge, { listened });
}

/** A phone that has scanned the QR: connects, handshakes, and can seal frames. */
async function phoneOn(payload: PairingPayload, token?: string) {
  const codec = new FrameCodec(Buffer.from(payload.key, "base64url"), "phone");
  const ws = new WebSocket(payload.addr, [token ?? codec.auth]);
  const raw: Uint8Array[] = [];
  // Opened once, on arrival: the codec's replay counter refuses a second look.
  const opened: BridgeFrame[] = [];
  let greeted: () => void;
  const shook = new Promise<void>((resolve) => { greeted = resolve; });
  ws.on("message", (data: Buffer, isBinary: boolean) => {
    if (!isBinary) return;
    if (data.byteLength === HANDSHAKE_BYTES) {
      codec.greet(data);
      greeted();
      return;
    }
    raw.push(new Uint8Array(data));
    const frame = codec.open(data);
    if (frame) opened.push(frame);
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.send(codec.hello);
  await shook;
  const tick = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  // Long enough to prove a frame did NOT arrive; the PIN check alone is a scrypt.
  const settle = () => tick(250);
  return {
    ws,
    raw,
    opened,
    live: () => opened.find((frame) => frame.k === "evt" && frame.t === "live"),
    async ask(id: string, method: string, params: Record<string, unknown>) {
      ws.send(codec.seal({ k: "req", id, method, params } as never)!);
      // Wait for the answer rather than a fixed delay: under the parallel test
      // pool a scrypt PIN check comfortably outruns any guess.
      const found = (): BridgeFrame | undefined => opened.find((frame) => frame.k === "res" && frame.id === id);
      for (let i = 0; i < 200 && !found(); i += 1) await tick(20);
      return found();
    },
    settle,
  };
}

test("the QR carries the address and key, and never the PIN", async (t) => {
  const bridge = bridgeOn(t);
  const payload = await bridge.pair(PIN);
  await bridge.listened;
  assert.equal(payload.addr, `ws://127.0.0.1:${BRIDGE_PORT}`);
  assert.equal(payload.name, "Test Mac");
  assert.equal(Buffer.from(payload.key, "base64url").length, 32);
  assert.doesNotMatch(JSON.stringify(payload), new RegExp(PIN));
});

test("a fresh pairing answers nothing until the phone proves the PIN", async (t) => {
  let dispatched = 0;
  const bridge = bridgeOn(t, idle, () => { dispatched += 1; return Promise.resolve({}); });
  const payload = await bridge.pair(PIN);
  await bridge.listened;
  const phone = await phoneOn(payload);

  const refused = await phone.ask("1", "snapshot", {});
  assert.ok(refused && refused.k === "res" && refused.ok === false);
  assert.match(refused.error, /PIN/);
  assert.equal(dispatched, 0, "an unverified phone reached the dispatcher");
  assert.equal(bridge.status().devices.length, 0, "the pairing committed before the PIN was proved");

  const wrong = await phone.ask("2", "unlock", { pin: "000000" });
  assert.ok(wrong && wrong.k === "res" && wrong.ok === false);
  assert.equal(bridge.status().devices.length, 0);

  const right = await phone.ask("3", "unlock", { pin: PIN });
  assert.ok(right && right.k === "res" && right.ok === true);
  assert.equal(bridge.status().devices.length, 1, "a proved PIN did not commit the pairing");

  const allowed = await phone.ask("4", "snapshot", {});
  assert.ok(allowed && allowed.k === "res" && allowed.ok === true);
  assert.equal(dispatched, 1);
  phone.ws.close();
});

test("wrong PINs are spent, not unlimited — the staged pairing dies before a 4-digit space does", async (t) => {
  const bridge = bridgeOn(t);
  const payload = await bridge.pair(PIN);
  await bridge.listened;
  const phone = await phoneOn(payload);
  for (let i = 0; i < 5; i += 1) await phone.ask(`w${i}`, "unlock", { pin: "000000" });
  assert.equal(bridge.status().devices.length, 0);
  const late = await phone.ask("late", "unlock", { pin: PIN });
  assert.ok(!late || (late.k === "res" && late.ok === false), "the right PIN still worked after the pairing was spent");
  assert.equal(bridge.status().devices.length, 0);
  phone.ws.close();
});

test("a phone without the auth token never reaches the handshake", async (t) => {
  const bridge = bridgeOn(t);
  const payload = await bridge.pair(PIN);
  await bridge.listened;
  await assert.rejects(phoneOn(payload, randomBytes(32).toString("hex")), /4\d\d|Unexpected server response/);
});

test("a pairing nobody scans expires on its own, without help from the renderer", async (t) => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"], now: Date.now() });
  t.after(() => mock.timers.reset());
  const bridge = bridgeOn(t);
  await bridge.pair(PIN);
  assert.equal(bridge.status().addr, `ws://127.0.0.1:${BRIDGE_PORT}`);
  mock.timers.tick(PAIRING_TTL_MS);
  assert.equal(bridge.status().devices.length, 0);
  assert.equal(bridge.status().pairing, false, "the staged pairing outlived its own deadline");
  assert.equal(bridge.status().addr, "");
});

test("greeting the bridge over and over does not rebuild the live state every time", async (t) => {
  let built = 0;
  const bridge = bridgeOn(t, () => { built += 1; return idle(); });
  const payload = await bridge.pair(PIN);
  await bridge.listened;
  const phone = await phoneOn(payload);
  const before = built;
  for (let i = 0; i < 20; i += 1) phone.ws.send(randomBytes(HANDSHAKE_BYTES));
  await phone.settle();
  assert.equal(built, before, "an unauthenticated greeting rebuilt and sealed the whole live state");
  phone.ws.close();
});

test("a phone that scanned the QR but has not proved the PIN is told nothing", async (t) => {
  const bridge = bridgeOn(t, () => ({ ...idle(), partial: { t1: { text: "the secret is", thinking: "" } } }));
  const payload = await bridge.pair(PIN);
  await bridge.listened;
  const phone = await phoneOn(payload);
  await phone.settle();
  bridge.ask(asking("during"));
  bridge.event({ k: "evt", t: "live", state: idle() });
  await phone.settle();
  assert.deepEqual(phone.raw, [], "the QR key alone bought a live feed of this Mac");

  await phone.ask("1", "unlock", { pin: PIN });
  assert.ok(phone.live(), "a proved phone was not handed the live state");
  phone.ws.close();
});

test("an unpaired Mac keeps no permission asks, and a pairing Mac hands the new ones over", async (t) => {
  const bridge = bridgeOn(t);
  for (let i = 0; i < 5; i += 1) bridge.ask(asking(`before-${i}`));
  const payload = await bridge.pair(PIN);
  await bridge.listened;
  const phone = await phoneOn(payload);
  await phone.ask("1", "unlock", { pin: PIN });
  const live = phone.live();
  assert.ok(live && live.k === "evt" && live.t === "live");
  assert.deepEqual(live.state.asks, [], "an unpaired Mac hoarded permission asks for the life of the process");
  phone.ws.close();
});

test("unpairing shuts the door, and the phone that was holding the key cannot reopen it", async (t) => {
  const bridge = bridgeOn(t);
  const payload = await bridge.pair(PIN);
  await bridge.listened;
  const phone = await phoneOn(payload);
  await phone.ask("1", "unlock", { pin: PIN });
  assert.equal(bridge.status().devices.length, 1);

  bridge.unpair();
  assert.equal(bridge.status().devices.length, 0);
  assert.equal(bridge.status().listening, false, "the port stayed open after the phone was revoked");
  // Revoking works with the phone offline or out of reach: it is the Mac that stops answering.
  await assert.rejects(phoneOn(payload), "a revoked phone reconnected on the key it already had");
});

test("pairing a replacement phone mints a new key, so the old phone's key is refused", async (t) => {
  const bridge = bridgeOn(t);
  const first = await bridge.pair(PIN);
  await bridge.listened;
  const old = await phoneOn(first);
  await old.ask("1", "unlock", { pin: PIN });
  old.ws.close();

  bridge.unpair();
  const second = await bridge.pair("9911");
  await bridge.listened;
  assert.notEqual(second.key, first.key);
  // Same address, new key — so the old phone fails the auth subprotocol, not the PIN.
  assert.equal(second.addr, first.addr);
  await assert.rejects(phoneOn(first), "the replaced phone still authenticated");
  const replacement = await phoneOn(second);
  const unlocked = await replacement.ask("1", "unlock", { pin: "9911" });
  assert.ok(unlocked && unlocked.k === "res" && unlocked.ok === true);
  replacement.ws.close();
});

/** The staged pairing tears the server down and back up; wait for the new one. */
async function serving(bridge: Harness) {
  for (let i = 0; i < 200 && !bridge.status().listening; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(bridge.status().listening, true, "the bridge never started listening");
}

/** Pairs one more phone and proves its PIN, leaving the phones already on untouched. */
async function join(bridge: Harness, pin = PIN) {
  const payload = await bridge.pair(pin);
  await serving(bridge);
  const phone = await phoneOn(payload);
  const proved = await phone.ask(`unlock-${payload.key.slice(0, 6)}`, "unlock", { pin });
  assert.ok(proved && proved.k === "res" && proved.ok === true, "a freshly paired phone could not prove its PIN");
  return phone;
}

test("three phones hold the line at once, and each one is answered on its own key", async (t) => {
  const bridge = bridgeOn(t);
  const first = await join(bridge);
  const second = await join(bridge);
  const third = await join(bridge);

  assert.equal(bridge.status().devices.length, 3);
  assert.deepEqual(bridge.status().devices.map((device) => device.connected), [true, true, true], "pairing a phone dropped the phones already on");

  // Each phone seals on its own key, so a broadcast that reaches all three proves
  // the Mac kept three separate codecs rather than one shared counter.
  bridge.resolved("ask-1", true);
  await third.settle();
  for (const [name, phone] of [["first", first], ["second", second], ["third", third]] as const) {
    assert.ok(
      phone.opened.some((frame) => frame.k === "evt" && frame.t === "permission-resolved" && frame.id === "ask-1"),
      `the ${name} phone never got the broadcast`,
    );
  }

  const answered = await second.ask("q", "snapshot", {});
  assert.ok(answered && answered.k === "res" && answered.ok === true);
  for (const phone of [first, second, third]) phone.ws.close();
});

test("a fourth phone is refused rather than quietly evicting one of the three", async (t) => {
  const bridge = bridgeOn(t);
  const phones = [await join(bridge), await join(bridge), await join(bridge)];
  await assert.rejects(bridge.pair(PIN), /3 devices/, "a fourth phone paired and pushed one of the three off");
  assert.equal(bridge.status().devices.length, 3, "the refused pairing still changed what is paired");
  assert.equal(bridge.status().pairing, false, "the refused pairing left a staged code behind");
  // The refusal must not cost the user the phones they already had.
  const answered = await phones[0].ask("q", "snapshot", {});
  assert.ok(answered && answered.k === "res" && answered.ok === true);
  for (const phone of phones) phone.ws.close();
});

test("revoking one phone leaves the other two paired and answering", async (t) => {
  const bridge = bridgeOn(t);
  const doomed = await join(bridge);
  const kept = await join(bridge);
  const gone = bridge.status().devices[0].id;

  bridge.unpair(gone);
  await doomed.settle();
  assert.equal(bridge.status().devices.length, 1, "revoking one phone took another with it");
  assert.equal(bridge.status().listening, true, "the port closed while a phone was still paired");
  assert.ok(doomed.opened.some((frame) => frame.k === "evt" && frame.t === "bye"), "the revoked phone was never told");
  assert.notEqual(doomed.ws.readyState, WebSocket.OPEN, "the revoked phone kept an open socket to ask on");

  const answered = await kept.ask("q", "snapshot", {});
  assert.ok(answered && answered.k === "res" && answered.ok === true, "the phone that was kept stopped being answered");
  kept.ws.close();
});
