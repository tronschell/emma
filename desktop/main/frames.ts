import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { HANDSHAKE_BYTES, isBridgeMethod, KEY_BYTES, LABEL_MAC_TO_PHONE, LABEL_PHONE_TO_MAC, LABEL_RELAY_AUTH, MAX_FRAME_BYTES, NONCE_BYTES, TAG_BYTES } from "../shared/mobile-protocol";
import type { BridgeFrame } from "../shared/mobile-protocol";

export type FrameRole = "mac" | "phone";

const CIPHER = "aes-256-gcm";
const SALT = Buffer.alloc(0);

function subkey(key: Buffer, label: string): Buffer {
  return Buffer.from(hkdfSync("sha256", key, SALT, label, KEY_BYTES));
}

function isFrame(value: unknown, role: FrameRole): value is BridgeFrame {
  if (typeof value !== "object" || value === null) return false;
  const frame = value as { k?: unknown; method?: unknown };
  if (frame.k === "req") return role === "mac" && isBridgeMethod(frame.method);
  return role === "phone" && (frame.k === "res" || frame.k === "evt");
}

export function relayAuth(key: Buffer): string {
  return createHash("sha256").update(key).update(LABEL_RELAY_AUTH).digest("hex");
}

export class FrameCodec {
  readonly auth: string;
  private readonly role: FrameRole;
  private readonly tx: Buffer;
  private readonly rx: Buffer;
  private mine = randomBytes(HANDSHAKE_BYTES);
  private theirs: Buffer | undefined;
  private session: Buffer | undefined;
  private sessionId = "";
  private readonly opened = new Set<string>();
  private sent = 0;
  private seen = 0;

  constructor(key: Buffer, role: FrameRole) {
    if (key.length !== KEY_BYTES) throw new Error(`a bridge key is ${KEY_BYTES} bytes, not ${key.length}`);
    this.auth = relayAuth(key);
    this.role = role;
    this.tx = subkey(key, role === "mac" ? LABEL_MAC_TO_PHONE : LABEL_PHONE_TO_MAC);
    this.rx = subkey(key, role === "mac" ? LABEL_PHONE_TO_MAC : LABEL_MAC_TO_PHONE);
  }

  get hello(): Uint8Array {
    return this.mine;
  }

  get ready(): boolean {
    return this.session !== undefined;
  }

  restart(): Uint8Array {
    this.mine = randomBytes(HANDSHAKE_BYTES);
    this.theirs = undefined;
    this.session = undefined;
    this.sessionId = "";
    this.opened.clear();
    this.sent = 0;
    this.seen = 0;
    return this.mine;
  }

  greet(data: ArrayBuffer | Uint8Array): boolean {
    if (data.byteLength !== HANDSHAKE_BYTES) return false;
    const bytes = Buffer.from(data instanceof Uint8Array ? data : new Uint8Array(data));
    if (this.theirs?.equals(bytes)) return false;
    const digest = createHash("sha256");
    digest.update(this.role === "mac" ? this.mine : bytes);
    digest.update(this.role === "mac" ? bytes : this.mine);
    const session = digest.digest();
    const id = session.toString("hex");
    if (this.opened.has(id)) return false;
    this.theirs = bytes;
    this.session = session;
    this.sessionId = id;
    this.sent = 0;
    this.seen = 0;
    return true;
  }

  seal(frame: BridgeFrame): Uint8Array | undefined {
    if (!this.session) return undefined;
    const iv = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(CIPHER, this.tx, iv);
    cipher.setAAD(this.session);
    const body = Buffer.concat([cipher.update(JSON.stringify({ n: ++this.sent, m: frame }), "utf8"), cipher.final()]);
    const sealed = Buffer.concat([iv, body, cipher.getAuthTag()]);
    return sealed.length > MAX_FRAME_BYTES ? undefined : sealed;
  }

  open(data: ArrayBuffer | Uint8Array): BridgeFrame | undefined {
    if (!this.session) return undefined;
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (bytes.length <= NONCE_BYTES + TAG_BYTES || bytes.length > MAX_FRAME_BYTES) return undefined;
    try {
      const decipher = createDecipheriv(CIPHER, this.rx, bytes.subarray(0, NONCE_BYTES));
      decipher.setAAD(this.session);
      decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
      const plain = Buffer.concat([decipher.update(bytes.subarray(NONCE_BYTES, bytes.length - TAG_BYTES)), decipher.final()]);
      const envelope = JSON.parse(plain.toString("utf8")) as { n?: unknown; m?: unknown };
      if (!Number.isSafeInteger(envelope?.n) || (envelope.n as number) <= this.seen) return undefined;
      if (!isFrame(envelope.m, this.role)) return undefined;
      this.seen = envelope.n as number;
      this.opened.add(this.sessionId);
      return envelope.m;
    } catch {
      return undefined;
    }
  }
}
