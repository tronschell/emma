import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FrameCodec } from "../main/frames";
import { HANDSHAKE_BYTES, MAX_ASK_MS, PAIRING_TTL_MS } from "../shared/mobile-protocol";
import type { DesktopIdentity, LiveState, PermissionAsk } from "../shared/mobile-protocol";

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

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createBridge }: typeof import("../main/bridge") = require("../main/bridge");

class FakeSocket {
  static readonly opened: FakeSocket[] = [];
  static readonly OPEN = 1;
  readyState = 0;
  binaryType = "";
  closed = false;
  readonly sent: (string | Uint8Array)[] = [];
  onopen: (() => void) | undefined;
  onmessage: ((message: { data: unknown }) => void) | undefined;
  onerror: (() => void) | undefined;
  onclose: (() => void) | undefined;

  constructor(readonly url: string) {
    FakeSocket.opened.push(this);
    queueMicrotask(() => {
      if (this.closed) return;
      this.readyState = FakeSocket.OPEN;
      this.onopen?.();
    });
  }

  get binaries(): Uint8Array[] {
    return this.sent.filter((item): item is Uint8Array => typeof item !== "string");
  }

  get last(): Uint8Array {
    const binaries = this.binaries;
    return binaries[binaries.length - 1];
  }

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
  }

  deliver(data: unknown): void {
    this.onmessage?.({ data });
  }
}

(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;

const RELAY = "wss://relay.test.workers.dev";
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

function bridgeOn(live: () => LiveState = idle) {
  FakeSocket.opened.length = 0;
  return createBridge({
    userData: mkdtempSync(path.join(tmpdir(), "emma-bridge-")),
    identity,
    dispatch: () => Promise.resolve({}),
    live,
    onStatus: () => undefined,
  });
}

function fakeClock(): void {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: Date.now() });
}

test("a pairing nobody scans expires on its own, without help from the renderer", async (t) => {
  fakeClock();
  t.after(() => mock.timers.reset());
  const bridge = bridgeOn();
  const payload = await bridge.pair(RELAY);
  const relay = FakeSocket.opened[0];
  assert.equal(FakeSocket.opened.length, 1);
  assert.equal(relay.closed, false);
  assert.equal(payload.relay, RELAY);

  mock.timers.tick(PAIRING_TTL_MS);
  assert.equal(relay.closed, true, "the pairing window closed but the room stayed claimed");
  assert.equal(FakeSocket.opened.length, 1);
  assert.equal(bridge.status().paired, false);
  assert.equal(bridge.status().name, "");
  bridge.stop();
});

test("greeting the bridge over and over does not rebuild the live state every time", async (t) => {
  fakeClock();
  t.after(() => mock.timers.reset());
  let built = 0;
  const bridge = bridgeOn(() => {
    built += 1;
    return idle();
  });
  await bridge.pair(RELAY);
  const relay = FakeSocket.opened[0];
  for (let i = 0; i < 20; i += 1) relay.deliver(randomBytes(HANDSHAKE_BYTES));
  assert.equal(built, 1, "an unauthenticated greeting rebuilt and sealed the whole live state");
  assert.equal(relay.binaries.filter((bytes) => bytes.length === HANDSHAKE_BYTES).length, 21);
  assert.equal(relay.binaries.filter((bytes) => bytes.length > HANDSHAKE_BYTES).length, 1);

  mock.timers.tick(5_000);
  relay.deliver(randomBytes(HANDSHAKE_BYTES));
  assert.equal(built, 2, "a phone that greets after the quiet window never got its live state");
  bridge.stop();
});

test("an unpaired Mac keeps no permission asks, and a pairing Mac hands the new ones over", async (t) => {
  fakeClock();
  t.after(() => mock.timers.reset());
  const bridge = bridgeOn();
  for (let i = 0; i < 5; i += 1) bridge.ask(asking(`before-${i}`));

  const payload = await bridge.pair(RELAY);
  const relay = FakeSocket.opened[0];
  const phone = new FrameCodec(Buffer.from(payload.key, "base64url"), "phone");
  const macHello = relay.binaries[0];
  assert.equal(phone.greet(macHello), true);
  relay.deliver(phone.hello);
  const first = phone.open(relay.last);
  assert.ok(first && first.k === "evt" && first.t === "live");
  assert.deepEqual(first.state.asks, [], "an unpaired Mac hoarded permission asks for the life of the process");

  bridge.ask(asking("after"));
  mock.timers.tick(5_000);
  const rejoin = phone.restart();
  assert.equal(phone.greet(macHello), true);
  relay.deliver(rejoin);
  const second = phone.open(relay.last);
  assert.ok(second && second.k === "evt" && second.t === "live");
  assert.deepEqual(
    second.state.asks.map((ask) => ask.id),
    ["after"],
  );
  bridge.stop();
});
