import test, { mock, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { WebSocket } from "ws";
import { FrameCodec } from "../main/frames";
import { validateRequest } from "../main/ipc";
import { BRIDGE_PORT, HANDSHAKE_BYTES, isBridgeMethod, MAX_ASK_MS, PAIRING_TTL_MS, READ_ONLY_METHODS } from "../shared/mobile-protocol";
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

// Bind the tests to loopback rather than whatever this machine's Tailscale or LAN address
// is. `mac.addresses` is what the pairing host currently resolves to: emptying it is this
// Mac losing the address it was serving on, which is what changing Wi-Fi looks like.
const mac = { host: "emma-test.local", addresses: ["127.0.0.1"] };
const tailnetPath = require.resolve("../main/tailnet");
require.cache[tailnetPath] = {
  id: tailnetPath,
  filename: tailnetPath,
  loaded: true,
  exports: {
    pairingHost: () => Promise.resolve(mac.host),
    addressesFor: (host: string) => Promise.resolve(host === mac.host ? [...mac.addresses] : []),
    preferredHost: () => mac.addresses[0],
    hosts: () => ({ tailnet: [], lan: [...mac.addresses] }),
    isTailnet: () => false,
  },
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

function bridgeOn(t: TestContext, live: () => LiveState = idle, dispatch: () => Promise<unknown> = () => Promise.resolve({}), userData = mkdtempSync(path.join(tmpdir(), "emma-bridge-"))): Harness {
  let ready: () => void;
  // A fixed port means a leftover process wedges the whole suite. Say so instead of hanging.
  const listened = new Promise<void>((resolve, reject) => {
    ready = resolve;
    const late = setTimeout(() => reject(new Error(`nothing is listening for emma-test.local on 127.0.0.1:${BRIDGE_PORT} — is another test process still holding it?`)), 5_000);
    late.unref();
  });
  const bridge = createBridge({
    userData,
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

/** Where a test phone actually dials: the QR carries a name, and only this Mac resolves it. */
const dial = (addr: string) => addr.replace(mac.host, "127.0.0.1");

/** A phone that has scanned the QR: connects, handshakes, and can seal frames. */
async function phoneOn(payload: PairingPayload, token?: string) {
  const codec = new FrameCodec(Buffer.from(payload.key, "base64url"), "phone");
  const ws = new WebSocket(dial(payload.addr), [token ?? codec.auth]);
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
  const dropped = new Promise<never>((_, reject) => {
    ws.once("close", (code: number) => reject(new Error(`the bridge closed this socket with ${code}`)));
  });
  ws.send(codec.hello);
  await Promise.race([shook, dropped]);
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
  assert.equal(payload.addr, `ws://emma-test.local:${BRIDGE_PORT}`);
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
  assert.equal(bridge.status().addr, `ws://emma-test.local:${BRIDGE_PORT}`);
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

test("a revoked phone that reconnects is shut with 4001, and never handshaken", async (t) => {
  const bridge = bridgeOn(t);
  const payload = await bridge.pair(PIN);
  await bridge.listened;
  const doomed = await phoneOn(payload);
  await doomed.ask("1", "unlock", { pin: PIN });
  // A second phone keeps the port open once the first one is revoked.
  const kept = await join(bridge);
  bridge.unpair(bridge.status().devices[0].id);
  doomed.ws.close();

  const codec = new FrameCodec(Buffer.from(payload.key, "base64url"), "phone");
  const back = new WebSocket(dial(payload.addr), [codec.auth]);
  const seen: Buffer[] = [];
  back.on("message", (data: Buffer) => seen.push(data));
  const code = await new Promise<number>((resolve, reject) => {
    back.once("close", resolve);
    back.once("error", reject);
  });
  assert.equal(code, 4001, "the revoked phone was not told its key is dead");
  assert.equal(seen.length, 0, "the revoked phone was handshaken before it was shut");
  kept.ws.close();
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

// bridgeDispatch is what a paired phone reaches across the network. main.ts cannot be
// imported (it boots Electron), so lift the two functions out and run them in a vm the
// way test/runtime-cancellation.test.ts lifts runEmmaTool.
const mainSource = ts.createSourceFile("main.ts", readFileSync(path.join(__dirname, "../../main/main.ts"), "utf8"), ts.ScriptTarget.Latest, true);
const lift = (name: string) =>
  mainSource.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name)!.getText(mainSource);
const dispatchSource = ts.transpileModule(`${lift("onlyOnce")}\n${lift("phoneJobs")}\n${lift("bridgeDispatch")}\nbridgeDispatch;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

type Dispatch = (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;

function dispatchOn(sandbox: Record<string, unknown>): Dispatch {
  return runInNewContext(dispatchSource, {
    app: { getPath: () => "/nowhere" },
    bridgeReplies: new Map<string, Map<string, unknown>>(),
    MAX_REPLIES_PER_THREAD: 32,
    MAX_REPLY_THREADS: 32,
    ...sandbox,
  }) as Dispatch;
}

test("readImage reads a granted or attached file, and refuses a stray path that merely ends in .jpg", async () => {
  const grant = "/Users/tester/Projects/emma";
  let read = "";
  const dispatch = dispatchOn({
    namedPath: (value: unknown) => (typeof value === "string" ? value : undefined),
    pathInside: (root: string, file: string) => file.startsWith(`${root}/`),
    folders: { list: () => [{ id: "f1", path: grant, name: "emma" }] },
    attachments: { holds: (file: string) => file === "/Users/tester/Library/emma/attachments/a.png" },
    nativeImage: { createFromPath: (file: string) => { read = file; return { isEmpty: () => false }; } },
    compressScreenFrame: () => ({ image: "data:image/jpeg;base64,AAAA" }),
  });

  await assert.rejects(
    dispatch("readImage", { path: "/Users/tester/Pictures/passport-scan.jpg" }),
    /Not an image Emma can show/,
    "a paired phone read a picture that is in no granted folder and is attached to nothing",
  );
  assert.equal(read, "", "the refused path was opened off disk anyway");

  assert.deepEqual({ ...(await dispatch("readImage", { path: `${grant}/docs/shot.png` })) }, { mime: "image/jpeg", base64: "AAAA" });
  assert.ok(await dispatch("readImage", { path: "/Users/tester/Library/emma/attachments/a.png" }));
});

test("addFolder grants only what resolves inside home, and decides before anything is granted", async () => {
  // Every other grant went through a native dialog. This one comes off the wire, so the
  // symlink out of home is the case a check on how the string reads would wave through.
  const home = "/Users/tester";
  const granted: string[] = [];
  const real: Record<string, string> = { [`${home}/Projects/away`]: "/Volumes/Backup/keys" };
  const dispatch = dispatchOn({
    path,
    homedir: () => home,
    realpathSync: (value: string) => real[value] ?? value,
    statSync: () => ({ isDirectory: () => true }),
    samePath: (left: string, right: string) => left === right,
    pathInside: (root: string, target: string) => target === root || target.startsWith(`${root}/`),
    folders: { list: () => [], add: (directory: string) => { granted.push(directory); return []; } },
    visibleFolders: () => granted.map((directory) => ({ id: directory, path: directory, name: "emma" })),
  });

  await assert.rejects(dispatch("addFolder", { path: "Projects/emma" }), /full path/, "a relative path was accepted");
  await assert.rejects(dispatch("addFolder", { path: "/etc" }), /home folder/, "a phone granted a folder outside the home folder");
  await assert.rejects(dispatch("addFolder", { path: `${home}/Projects/away` }), /home folder/, "a symlink out of home read as a folder in home");
  assert.deepEqual(granted, [], "a folder was granted before the guard turned the path away");

  await dispatch("addFolder", { path: `${home}/Projects/emma` });
  assert.deepEqual(granted, [`${home}/Projects/emma`], "a folder in the home folder was refused");
});

test("a phone that replays one request id is answered from the first reply, not steered twice", async () => {
  let steered = 0;
  const dispatch = dispatchOn({
    agentMessage: (params: Record<string, unknown>) => ({ threadId: String(params.threadId), text: String(params.text) }),
    steerThread: async () => { steered += 1; },
  });
  const params = { threadId: "t1", clientId: "c1", text: "stop and explain" };

  const first = await dispatch("steerAgent", { ...params });
  const again = await dispatch("steerAgent", { ...params });
  assert.deepEqual({ ...first }, { steered: true });
  assert.equal(again, first, "the replay was answered with a fresh run rather than the first reply");
  assert.equal(steered, 1, "a resent request ran the turn a second time");

  await dispatch("steerAgent", { ...params, clientId: "c2" });
  assert.equal(steered, 2, "a genuinely new request was swallowed by the dedupe guard");
});

test("a key revoked before a restart is still turned away with 4001, not a bare 1006", async (t) => {
  const userData = mkdtempSync(path.join(tmpdir(), "emma-bridge-"));
  const before = bridgeOn(t, idle, () => Promise.resolve({}), userData);
  const payload = await before.pair(PIN);
  await before.listened;
  const doomed = await phoneOn(payload);
  await doomed.ask("1", "unlock", { pin: PIN });
  // A second phone keeps something paired, so the restarted bridge has a port to open.
  const kept = await join(before);
  before.unpair(before.status().devices[0].id);
  doomed.ws.close();
  kept.ws.close();
  before.stop();

  const after = bridgeOn(t, idle, () => Promise.resolve({}), userData);
  after.start();
  await after.listened;
  const codec = new FrameCodec(Buffer.from(payload.key, "base64url"), "phone");
  const back = new WebSocket(dial(payload.addr), [codec.auth]);
  const code = await new Promise<number>((resolve, reject) => {
    back.once("close", resolve);
    back.once("error", reject);
  });
  assert.equal(code, 4001, "after a restart the revoked phone got a close it cannot explain, so it retries forever");
});

test("this Mac moving to another network rebinds the same pairing, and the phone relinks without pairing again", async (t) => {
  t.after(() => { mac.addresses = ["127.0.0.1"]; });
  const bridge = bridgeOn(t);
  const payload = await bridge.pair(PIN);
  await bridge.listened;
  const phone = await phoneOn(payload);
  await phone.ask("1", "unlock", { pin: PIN });
  phone.ws.close();

  // The name stops answering to this Mac: the port goes, the pairing stays.
  mac.addresses = [];
  await bridge.recheck();
  assert.equal(bridge.status().listening, false, "the bridge kept a port open on an address this Mac no longer has");
  assert.equal(bridge.status().devices.length, 1, "an address change threw the pairing away");
  assert.match(bridge.status().reason, /reachable/);

  // A different address, the same name: rebound, on the key that was already minted.
  mac.addresses = ["127.0.0.1"];
  await bridge.recheck();
  await serving(bridge);
  assert.equal(bridge.status().reason, "");
  assert.equal(bridge.status().devices.length, 1);
  const back = await phoneOn(payload);
  const answered = await back.ask("2", "snapshot", {});
  assert.ok(answered && answered.k === "res" && answered.ok === true, "the phone had to pair again after this Mac moved");
  back.ws.close();
});

test("the QR never carries an mDNS name, which anyone on the LAN can answer to", () => {
  // The phone offers the bridge auth token as its WebSocket subprotocol before anything
  // is mutually authenticated, so a name a stranger can claim hands them that token.
  const source = readFileSync(path.join(__dirname, "../../main/tailnet.ts"), "utf8");
  assert.doesNotMatch(source, /hostname\(|\.local["'`]/, "pairingHost is building a name off this Mac's hostname again");
});

test("the Mac's scheduled tasks reach a phone without their graph, and come back through the renderer's own validation", async () => {
  // The host allowlist is the only thing standing between a phone and a task that runs on this
  // Mac, so the writes are handed the real validateRequest here rather than a stand-in.
  const stored = [{
    id: "job-123456789012", title: "Weekly reading", schedule: "0 9 * * 1", prompt: "Find reading",
    nodes: '[{"id":"step-1","kind":"agent","text":"read"}]', outputs: "digest=...",
    sourceDomains: ["example.com"], enabled: true, permissionMode: "ask", model: "",
    nextRunAt: "2026-09-07T09:00:00.000Z", lastRunAt: null,
  }];
  const forwarded: unknown[] = [];
  const dispatch = dispatchOn({
    validateRequest,
    scheduledJobs: async () => stored,
    runRequest: async (request: unknown) => { forwarded.push(request); },
  });

  // The vm hands back cross-realm objects, so the shapes are compared as JSON.
  const listed = await dispatch("listScheduledJobs", {}) as unknown as Record<string, unknown>[];
  assert.deepEqual(Object.keys(listed[0]).sort(), ["enabled", "id", "lastRunAt", "model", "nextRunAt", "permissionMode", "prompt", "schedule", "sourceDomains", "title"]);

  assert.deepEqual({ ...(await dispatch("runScheduledJob", { jobId: stored[0].id })) }, { started: true });
  assert.equal(JSON.stringify(await dispatch("setScheduledJobEnabled", { jobId: stored[0].id, enabled: false })), JSON.stringify(listed));
  assert.equal(JSON.stringify(forwarded), JSON.stringify([
    { method: "runScheduledJob", params: { jobId: stored[0].id } },
    { method: "setScheduledJobEnabled", params: { jobId: stored[0].id, enabled: "false" } },
  ]), "a scheduled write reached the host as something other than the renderer's own payload");

  // A boolean the host would refuse with an opaque error, and a field the allowlist does not name.
  await assert.rejects(dispatch("setScheduledJobEnabled", { jobId: stored[0].id, enabled: "false" }), /Enabled is invalid/);
  await assert.rejects(dispatch("deleteScheduledJob", { jobId: "" }), /Invalid parameters/);
  await assert.rejects(dispatch("saveScheduledJob", { title: "Weekly", schedule: "manual", prompt: "Find", sourceDomains: "[]", permissionMode: "ask", danger: "1" }), /Invalid parameters/);
  assert.equal(forwarded.length, 2, "a refused scheduled write still reached the host");
});

test("every method a phone can dispatch is classified, and only readers are read-only", () => {
  // READ_ONLY_METHODS has no gate in bridge.ts on purpose: an unverified phone is refused
  // every method, which is stricter than any read/write split. So the list is a claim
  // about bridgeDispatch, and its names are what makes the claim checkable.
  const READS = /^(snapshot|live|thread(Messages|Traces|Changes)|keyStatus|git(Ready|Status|FileDiff|History|Message)|(get|list|read)[A-Z])/;
  const dispatched = [...dispatchSource.matchAll(/case "(\w+)":/g)].map((found) => found[1]).filter(isBridgeMethod);
  assert.ok(dispatched.length > 40, "bridgeDispatch's cases were not found, so this test proves nothing");
  for (const method of dispatched) {
    assert.equal(READ_ONLY_METHODS.includes(method), READS.test(method), `${method} is on the wrong side of READ_ONLY_METHODS`);
  }
  for (const method of READ_ONLY_METHODS) {
    assert.ok(dispatched.includes(method), `READ_ONLY_METHODS names ${method}, which bridgeDispatch does not answer`);
  }
});
