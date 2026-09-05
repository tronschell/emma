import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { createGunzip } from "node:zlib";
import { updateOrigin } from "../shared/update";
import { DEFAULT_TOOLS_ORIGIN, ZVEC_GREP_ENTRY, ZVEC_GREP_VERSION, zvecGrepUrl, type ZvecGrepPhase, type ZvecGrepStatus } from "../shared/zvec-grep";

const BLOCK = 512;
const PIECE = 1024 * 1024;
const NOTIFY_MS = 250;

const text = (header: Buffer, at: number, length: number) => {
  const field = header.subarray(at, at + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
};

const octal = (header: Buffer, at: number, length: number) => Number.parseInt(text(header, at, length).trim() || "0", 8) || 0;

export function tarEntryPath(into: string, name: string): string {
  const clean = name.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!clean || clean === ".") return "";
  if (clean.startsWith("/") || /^[a-z]:/i.test(clean)) throw new Error(`The zvec-grep archive holds an absolute path: ${name}`);
  if (clean.split("/").some((part) => part === "..")) throw new Error(`The zvec-grep archive escapes its directory: ${name}`);
  const root = path.resolve(into);
  const target = path.resolve(into, clean);
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`The zvec-grep archive escapes its directory: ${name}`);
  return target;
}

function reader(stream: NodeJS.ReadableStream) {
  const chunks = stream[Symbol.asyncIterator]();
  let held: Buffer = Buffer.alloc(0);
  return async (count: number): Promise<Buffer> => {
    while (held.length < count) {
      const next = await chunks.next();
      if (next.done) return Buffer.alloc(0);
      held = held.length ? Buffer.concat([held, next.value as Buffer]) : (next.value as Buffer);
    }
    const out = held.subarray(0, count);
    held = held.subarray(count);
    return out;
  };
}

export async function extractTarGz(source: NodeJS.ReadableStream, into: string, stopped: () => boolean) {
  const gunzip = createGunzip();
  source.pipe(gunzip);
  const read = reader(gunzip);
  const take = async (count: number) => {
    const piece = await read(count);
    if (count && !piece.length) throw new Error("The zvec-grep archive ended early.");
    return piece;
  };
  let longName = "";
  mkdirSync(into, { recursive: true });
  for (;;) {
    if (stopped()) throw new Error("The zvec-grep download was cancelled.");
    const header = await read(BLOCK);
    if (header.length < BLOCK || header[0] === 0) return;
    const size = octal(header, 124, 12);
    const padding = Math.ceil(size / BLOCK) * BLOCK - size;
    const type = String.fromCharCode(header[156]);
    const name = longName || (text(header, 345, 155) ? `${text(header, 345, 155)}/${text(header, 0, 100)}` : text(header, 0, 100));
    longName = "";
    if (type === "L" || type === "x" || type === "g") {
      const meta = (await take(size)).toString("utf8");
      if (type === "L") longName = meta.replace(/\0+$/, "");
      if (type === "x") longName = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(meta)?.[1] ?? "";
      await take(padding);
      continue;
    }
    if (type === "1" || type === "2") throw new Error(`The zvec-grep archive holds a link: ${name}`);
    const target = tarEntryPath(into, name);
    if (type === "5") {
      if (target) mkdirSync(target, { recursive: true });
      await take(padding);
      continue;
    }
    if (!target || (type !== "0" && type !== "\0")) {
      let skipped = size;
      while (skipped > 0) skipped -= (await take(Math.min(skipped, PIECE))).length;
      await take(padding);
      continue;
    }
    mkdirSync(path.dirname(target), { recursive: true });
    const handle = await open(target, "w", (octal(header, 100, 8) & 0o777) || 0o644);
    try {
      let left = size;
      while (left > 0) {
        if (stopped()) throw new Error("The zvec-grep download was cancelled.");
        const piece = await take(Math.min(left, PIECE));
        await handle.write(piece);
        left -= piece.length;
      }
    } finally {
      await handle.close();
    }
    await take(padding);
  }
}

export function toolsOrigin(): string {
  if (!process.env.EMMA_TOOLS_URL) return DEFAULT_TOOLS_ORIGIN;
  const origin = updateOrigin(process.env.EMMA_TOOLS_URL);
  if (origin) return origin;
  console.error("Emma: EMMA_TOOLS_URL is not an https origin; falling back to GitHub");
  return DEFAULT_TOOLS_ORIGIN;
}

export class ZvecGrepTool {
  private phase: ZvecGrepPhase;
  private bytes = 0;
  private total = 0;
  private detail = "";
  private notified = 0;
  private controller?: AbortController;

  constructor(private readonly root: string, private readonly origin: string, private readonly onChange: () => void) {
    this.phase = this.entry() ? "ready" : "missing";
    this.sweep();
  }

  entry(): string {
    const file = path.join(this.root, ZVEC_GREP_VERSION, ZVEC_GREP_ENTRY);
    return existsSync(file) ? file : "";
  }

  status(): ZvecGrepStatus {
    return { phase: this.phase, version: ZVEC_GREP_VERSION, bytes: this.bytes, total: this.total, detail: this.detail };
  }

  install() {
    if (this.phase === "downloading" || this.phase === "verifying" || this.phase === "extracting") return this.status();
    if (this.entry()) {
      this.settle("ready", "");
      return this.status();
    }
    const controller = new AbortController();
    this.controller = controller;
    this.bytes = 0;
    this.total = 0;
    this.settle("downloading", "");
    void this.run(controller).catch((error: unknown) => {
      if (this.stopped(controller)) return;
      this.controller = undefined;
      this.settle("failed", error instanceof Error ? error.message : String(error));
    });
    return this.status();
  }

  cancel() {
    this.controller?.abort();
    this.controller = undefined;
    if (this.phase !== "ready") this.settle(this.entry() ? "ready" : "missing", "");
    return this.status();
  }

  private stopped(controller?: AbortController) {
    return controller !== this.controller || controller?.signal.aborted === true;
  }

  private settle(phase: ZvecGrepPhase, detail: string) {
    this.phase = phase;
    this.detail = detail;
    this.notified = 0;
    this.onChange();
  }

  private tick() {
    if (Date.now() - this.notified < NOTIFY_MS) return;
    this.notified = Date.now();
    this.onChange();
  }

  private sweep() {
    try {
      for (const name of readdirSync(this.root)) {
        if (name === ZVEC_GREP_VERSION && this.entry()) continue;
        rmSync(path.join(this.root, name), { recursive: true, force: true });
      }
    } catch {
      return;
    }
  }

  private async fetchDigest(controller: AbortController): Promise<string> {
    const url = `${zvecGrepUrl(this.origin, process.platform, process.arch)}.sha256`;
    const response = await fetch(url, { signal: controller.signal, redirect: "follow" });
    if (!response.ok) throw new Error(`zvec-grep ${ZVEC_GREP_VERSION} is not published for this computer yet (${response.status}).`);
    const digest = /^[0-9a-f]{64}/.exec((await response.text()).trim());
    if (!digest) throw new Error("The zvec-grep checksum could not be read.");
    return digest[0];
  }

  private async download(controller: AbortController, tarball: string): Promise<string> {
    const response = await fetch(zvecGrepUrl(this.origin, process.platform, process.arch), { signal: controller.signal, redirect: "follow" });
    if (!response.ok || !response.body) throw new Error(`zvec-grep ${ZVEC_GREP_VERSION} could not be downloaded (${response.status}).`);
    this.total = Number(response.headers.get("content-length") ?? 0);
    const hash = createHash("sha256");
    const file = createWriteStream(tarball);
    const chunks = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await chunks.read();
        if (done) break;
        hash.update(value);
        this.bytes += value.length;
        if (!file.write(value)) await new Promise<void>((resolve) => file.once("drain", () => resolve()));
        this.tick();
      }
    } finally {
      await new Promise<void>((resolve) => file.end(() => resolve()));
    }
    return hash.digest("hex");
  }

  private async run(controller: AbortController) {
    mkdirSync(this.root, { recursive: true });
    const stamp = `${Date.now().toString(36)}`;
    const tarball = path.join(this.root, `download-${stamp}.tar.gz`);
    const staging = path.join(this.root, `${ZVEC_GREP_VERSION}.tmp-${stamp}`);
    try {
      const expected = await this.fetchDigest(controller);
      const digest = await this.download(controller, tarball);
      if (this.stopped(controller)) throw new Error("The zvec-grep download was cancelled.");
      this.settle("verifying", "");
      if (digest !== expected) throw new Error("The zvec-grep download did not match its checksum.");
      this.settle("extracting", "");
      await extractTarGz(createReadStream(tarball), staging, () => this.stopped(controller));
      if (!existsSync(path.join(staging, ZVEC_GREP_ENTRY))) throw new Error("The zvec-grep archive is missing its entry point.");
      rmSync(path.join(this.root, ZVEC_GREP_VERSION), { recursive: true, force: true });
      renameSync(staging, path.join(this.root, ZVEC_GREP_VERSION));
      this.controller = undefined;
      this.sweep();
      this.settle("ready", "");
    } finally {
      rmSync(tarball, { force: true });
      rmSync(staging, { recursive: true, force: true });
    }
  }
}
