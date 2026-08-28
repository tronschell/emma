import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { FrameCodec, relayAuth } from "../main/frames";
import { HANDSHAKE_BYTES, KEY_BYTES, LABEL_PHONE_TO_MAC, MAX_FRAME_BYTES, NONCE_BYTES, TAG_BYTES } from "../shared/mobile-protocol";
import type { BridgeFrame } from "../shared/mobile-protocol";

const key = randomBytes(KEY_BYTES);
const request: BridgeFrame = { k: "req", id: "r1", method: "sendMessage", params: { threadId: "t1", content: "ship it" } };
const goodbye: BridgeFrame = { k: "evt", t: "bye", reason: "revoked" };

type Link = { mac: FrameCodec; phone: FrameCodec; session: Buffer };

function link(): Link {
  const mac = new FrameCodec(key, "mac");
  const phone = new FrameCodec(key, "phone");
  const macHello = mac.restart();
  const phoneHello = phone.restart();
  assert.equal(phone.greet(macHello), true);
  assert.equal(mac.greet(phoneHello), true);
  assert.equal(phone.greet(macHello), false);
  return { mac, phone, session: createHash("sha256").update(macHello).update(phoneHello).digest() };
}

function sealed(codec: FrameCodec, frame: BridgeFrame): Uint8Array {
  const bytes = codec.seal(frame);
  assert.ok(bytes, "the codec refused to seal a frame it should have sealed");
  return bytes;
}

function forge(session: Buffer, plain: string, label = LABEL_PHONE_TO_MAC, secret = key): Uint8Array {
  const iv = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), label, KEY_BYTES)), iv);
  cipher.setAAD(session);
  return Buffer.concat([iv, cipher.update(plain, "utf8"), cipher.final(), cipher.getAuthTag()]);
}

test("a request sealed on the phone opens on the Mac and nowhere else", () => {
  const { mac, phone } = link();
  const bytes = sealed(phone, request);
  assert.equal(bytes.length, NONCE_BYTES + TAG_BYTES + Buffer.byteLength(JSON.stringify({ n: 1, m: request })));
  assert.equal(Buffer.from(bytes).toString("latin1").includes("sendMessage"), false);
  assert.deepEqual(mac.open(bytes), request);
  assert.equal(new FrameCodec(key, "phone").open(bytes), undefined);
  assert.equal(new FrameCodec(randomBytes(KEY_BYTES), "mac").open(bytes), undefined);
});

test("nothing seals or opens before the two ends have greeted each other", () => {
  const fresh = new FrameCodec(key, "phone");
  assert.equal(fresh.ready, false);
  assert.equal(fresh.seal(request), undefined);
  const { mac, phone, session } = link();
  assert.equal(mac.ready, true);
  const bytes = sealed(phone, request);
  assert.equal(new FrameCodec(key, "mac").open(bytes), undefined);
  assert.deepEqual(mac.open(forge(session, JSON.stringify({ n: 9, m: request }))), request);
});

test("a frame captured on one connection is dead on the next one", () => {
  const { mac, phone } = link();
  const captured = sealed(phone, request);
  assert.deepEqual(mac.open(captured), request);

  const macHello = mac.restart();
  const phoneHello = phone.restart();
  phone.greet(macHello);
  mac.greet(phoneHello);
  assert.equal(mac.open(captured), undefined, "a reconnect reopened the replay window");
  assert.deepEqual(mac.open(sealed(phone, request)), request);
});

test("a Mac only ever accepts requests, and a phone never does", () => {
  const { mac, phone, session } = link();
  assert.equal(mac.open(sealed(mac, goodbye)), undefined);
  assert.equal(mac.open(forge(session, JSON.stringify({ n: 1, m: goodbye }))), undefined);
  assert.deepEqual(phone.open(sealed(mac, goodbye)), goodbye);
  assert.equal(phone.open(sealed(phone, request)), undefined);
});

test("both ends agree on one relay token, and it is a deterministic sha256 hex", () => {
  const { mac, phone } = link();
  assert.equal(mac.auth, phone.auth);
  assert.equal(mac.auth, relayAuth(key));
  assert.match(mac.auth, /^[0-9a-f]{64}$/);
  assert.notEqual(relayAuth(randomBytes(KEY_BYTES)), mac.auth);
});

test("a captured frame is accepted once, and a stale counter never reopens", () => {
  const { mac, phone, session } = link();
  const first = sealed(phone, request);
  const second = sealed(phone, request);
  assert.deepEqual(mac.open(first), request);
  assert.equal(mac.open(first), undefined);
  assert.deepEqual(mac.open(second), request);
  assert.equal(mac.open(second), undefined);
  assert.equal(mac.open(forge(session, JSON.stringify({ n: 2, m: request }))), undefined);
  assert.equal(mac.open(forge(session, JSON.stringify({ n: 0, m: request }))), undefined);
  assert.deepEqual(mac.open(forge(session, JSON.stringify({ n: 3, m: request }))), request);
});

test("a greeting that repeats is ignored, and one of the wrong size is not a greeting", () => {
  const mac = new FrameCodec(key, "mac");
  mac.restart();
  assert.equal(mac.greet(randomBytes(HANDSHAKE_BYTES - 1)), false);
  assert.equal(mac.greet(randomBytes(HANDSHAKE_BYTES + 1)), false);
  assert.equal(mac.ready, false);
  const hello = randomBytes(HANDSHAKE_BYTES);
  assert.equal(mac.greet(hello), true);
  assert.equal(mac.greet(hello), false);
  assert.equal(mac.greet(Uint8Array.from(hello)), false);
  assert.equal(mac.greet(randomBytes(HANDSHAKE_BYTES)), true, "a phone that rejoins with a fresh hello has to be heard");
});

test("a junk greeting cannot rewind the handshake onto a session that already carried a frame", () => {
  const { mac, phone } = link();
  const captured = sealed(phone, request);
  assert.deepEqual(mac.open(captured), request);

  assert.equal(mac.greet(randomBytes(HANDSHAKE_BYTES)), true);
  assert.equal(mac.greet(phone.hello), false, "a replayed hello restored a spent session");
  assert.equal(mac.open(captured), undefined, "a junk greeting reopened the replay window");
  assert.equal(mac.open(sealed(phone, request)), undefined);
});

test("a phone that rejoins mid-connection is heard again, and its old frames are not", () => {
  const { mac, phone } = link();
  const captured = sealed(phone, request);
  assert.deepEqual(mac.open(captured), request);

  const rejoined = phone.restart();
  assert.equal(mac.greet(rejoined), true, "a genuine reconnect was refused");
  assert.equal(phone.greet(mac.hello), true);
  assert.deepEqual(mac.open(sealed(phone, request)), request);
  assert.equal(mac.open(captured), undefined);
});

test("flipping any single byte of a sealed frame drops it", () => {
  const { mac, phone } = link();
  const bytes = sealed(phone, request);
  for (let i = 0; i < bytes.length; i += 1) {
    const tampered = Uint8Array.from(bytes);
    tampered[i] ^= 1;
    assert.equal(mac.open(tampered), undefined, `byte ${i} was accepted`);
  }
  assert.deepEqual(mac.open(bytes), request);
});

test("hostile input comes back undefined instead of throwing", () => {
  const { mac, session } = link();
  for (const junk of [new Uint8Array(0), new Uint8Array(NONCE_BYTES + TAG_BYTES), randomBytes(200), new Uint8Array(MAX_FRAME_BYTES + 1)]) {
    assert.equal(mac.open(junk), undefined);
  }
  assert.equal(mac.open(randomBytes(64).buffer), undefined);
  assert.equal(mac.open(forge(session, "not json at all")), undefined);
  assert.equal(mac.open(forge(session, "null")), undefined);
  assert.equal(mac.open(forge(session, JSON.stringify({ n: 1.5, m: request }))), undefined);
  assert.equal(mac.open(forge(session, JSON.stringify({ n: "1", m: request }))), undefined);
  assert.equal(mac.open(forge(session, JSON.stringify({ m: request }))), undefined);
});

test("a frame larger than the cap is never sealed rather than sent and dropped", () => {
  const { mac, phone } = link();
  const huge: BridgeFrame = { k: "res", id: "r1", ok: true, result: "x".repeat(MAX_FRAME_BYTES) } as BridgeFrame;
  assert.equal(mac.seal(huge), undefined);
  assert.deepEqual(phone.open(sealed(mac, goodbye)), goodbye);
});

test("only the known methods survive the boundary", () => {
  const { mac, session } = link();
  const bad = [
    { k: "req", id: "x", method: "runShell", params: { cmd: "rm -rf ~" } },
    { k: "req", id: "x", method: "constructor", params: {} },
    { k: "req", id: "x", method: "__proto__", params: {} },
    { k: "req", id: "x", params: {} },
    { k: "exec", id: "x" },
    "sendMessage",
    42,
    [request],
  ];
  bad.forEach((m, i) => assert.equal(mac.open(forge(session, JSON.stringify({ n: i + 1, m }))), undefined, JSON.stringify(m)));
  assert.deepEqual(mac.open(forge(session, JSON.stringify({ n: 99, m: request }))), request);
});

test("a key that is not 32 bytes is refused at construction rather than failing silently later", () => {
  assert.throws(() => new FrameCodec(randomBytes(16), "mac"), /32 bytes/);
  assert.throws(() => new FrameCodec(Buffer.alloc(0), "phone"), /32 bytes/);
});
