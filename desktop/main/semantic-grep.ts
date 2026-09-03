import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { indexProgress, type SemanticGrepFolder, type SemanticGrepStatus } from "../shared/semantic-grep";
import { hostedEmbeddingModel, type HarnessExperiments, type HostedEmbeddingModel } from "../shared/settings";

export const ZG_ENTRY = "node_modules/@zvec/zvec-grep/dist/cli/index.js";
const INDEX_DIR = ".zvec-grep";
const REMOTE_MODEL = "qwen/text-embedding-v4";
const DIMENSIONS = 1024;
const CONCURRENCY = "4";
const RETRY_MS = 5 * 60 * 1000;
const ESTIMATE_AFTER_FILES = 25;
const ESTIMATE_AFTER_MS = 10_000;
const LLAMA_MODELS = new Set(["local/embeddinggemma-300m", "local/qwen3-embedding-0.6b"]);
const DETAIL_LINE = /^(?:Scanning files|Preparing |Downloading |Model ready)/;
const KEEP_ENV = new Set(["PATH", "HOME", "TMPDIR", "ELECTRON_RUN_AS_NODE", ...(process.platform === "win32" ? ["USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot"] : [])]);

type Embedding = { name: string; value: string }[];

export function proxyPort(seed: string): number {
  return 20000 + (createHash("sha256").update(seed).digest().readUInt32BE(0) % 40000);
}

export function zvecHome(): string {
  return path.join(os.homedir(), INDEX_DIR);
}

export function semanticGrepOption(node: string, entry: string, embedding: Embedding): string {
  return JSON.stringify({ name: "zvec-grep", command: node, args: [entry], env: [{ name: "ELECTRON_RUN_AS_NODE", value: "1" }, ...embedding] });
}

export function failureDetail(text: string): string {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => line.toLowerCase().startsWith("error")) ?? lines[0] ?? "";
}

export function embeddingProxy(model: HostedEmbeddingModel, token: string, key: () => string): http.Server {
  return http.createServer(async (req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const fail = (status: number, message: string) => reply(status, { error: { message } });
    try {
      if (req.headers.authorization !== `Bearer ${token}`) return fail(401, "The embedding proxy token did not match");
      if (req.method !== "POST") return fail(405, "Only POST is accepted");
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { input?: unknown };
      if (!body || !Array.isArray(body.input) || !body.input.every((item) => typeof item === "string")) return fail(400, "input must be an array of strings");
      const secret = key();
      if (!secret) return fail(401, `Needs ${model.credentialEnv}`);
      const upstream = await fetch(model.endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: JSON.stringify({ model: model.model, input: body.input, encoding_format: "float", ...(model.acceptsDimensions ? { dimensions: DIMENSIONS } : {}) }),
      });
      const json = (await upstream.json()) as { data?: unknown };
      if (!upstream.ok) return reply(upstream.status, json);
      if (!Array.isArray(json.data)) return fail(502, `${model.model} returned no embeddings`);
      for (const item of json.data as { embedding?: unknown }[]) {
        if (!item || !Array.isArray(item.embedding) || !item.embedding.every((n) => typeof n === "number")) return fail(502, `${model.model} returned an invalid embedding`);
        if (item.embedding.length < DIMENSIONS) return fail(502, `${model.model} returns ${item.embedding.length} dimensions; zvec-grep needs ${DIMENSIONS}`);
        item.embedding = normalize((item.embedding as number[]).slice(0, DIMENSIONS));
      }
      return reply(200, json);
    } catch (error) {
      return fail(502, error instanceof Error ? error.message : String(error));
    }
  });
}

function normalize(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, n) => sum + n * n, 0)) || 1;
  return vector.map((n) => n / norm);
}

function realRoot(root: string): string {
  try {
    return realpathSync.native(root);
  } catch {
    return root;
  }
}

function daemonTokenFile(): string {
  const file = path.join(zvecHome(), "daemon", "token");
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    if (!existsSync(file)) writeFileSync(file, `${randomBytes(24).toString("hex")}\n`, { mode: 0o600 });
    return file;
  } catch {
    return "";
  }
}

export class SemanticGrep {
  private folders = new Map<string, SemanticGrepFolder>();
  private children = new Map<string, ChildProcess>();
  private failedAt = new Map<string, number>();
  private rebuild = new Set<string>();
  private experiments?: HarnessExperiments;
  private proxy?: { server: http.Server; model: HostedEmbeddingModel; token: string; error: string };

  constructor(private readonly node: string, private readonly entry: string, readonly available: boolean, private readonly port: number, private readonly onChange: () => void) {}

  status(): SemanticGrepStatus {
    return { available: this.available, enabled: this.experiments?.semanticGrep === true, model: this.experiments?.embeddingModel ?? "", folders: [...this.folders.values()] };
  }

  option(experiments: HarnessExperiments, root?: string): string {
    if (!experiments.semanticGrep || !this.available) return "";
    const key = root === undefined ? undefined : realRoot(root);
    const hosted = hostedEmbeddingModel(experiments.embeddingModel);
    if (hosted && !process.env[hosted.credentialEnv]) {
      if (key) this.fail(key, `Needs ${hosted.credentialEnv}`);
      return "";
    }
    if (this.proxy?.error) {
      if (key) this.fail(key, `Embedding proxy: ${this.proxy.error}`);
      return "";
    }
    const embedding = this.embedding(experiments.embeddingModel);
    if (!key) return semanticGrepOption(this.node, this.entry, embedding);
    const known = this.folders.get(key);
    if (known?.state === "ready" && !existsSync(path.join(key, INDEX_DIR))) this.folders.delete(key);
    const folder = this.folders.get(key);
    if (!folder || (folder.state === "failed" && Date.now() - (this.failedAt.get(key) ?? 0) >= RETRY_MS)) this.index(key, experiments.embeddingModel);
    return this.folders.get(key)?.state === "ready" ? semanticGrepOption(this.node, this.entry, embedding) : "";
  }

  apply(experiments: HarnessExperiments) {
    const previous = this.experiments;
    this.experiments = experiments;
    if (!this.available) return;
    const changed = previous !== undefined && previous.embeddingModel !== experiments.embeddingModel;
    if (changed) {
      const indexed = [...this.folders.keys()];
      for (const child of this.children.values()) child.kill();
      this.children.clear();
      this.folders.clear();
      this.failedAt.clear();
      this.rebuild = new Set(indexed);
      if (hostedEmbeddingModel(previous.embeddingModel) && !hostedEmbeddingModel(experiments.embeddingModel)) {
        for (const root of indexed) this.revoke(root);
      }
      this.onChange();
    }
    this.serve(experiments);
    if (experiments.semanticGrep && (!previous?.semanticGrep || changed)) this.restartDaemon(experiments);
    if (!experiments.semanticGrep && previous?.semanticGrep) this.stopDaemon();
  }

  stop() {
    if (this.available && this.experiments?.semanticGrep) spawnSync(this.node, [this.entry, "server", "off"], { env: this.env(), timeout: 5000, windowsHide: true });
    this.closeProxy();
  }

  private closeProxy() {
    this.proxy?.server.closeAllConnections();
    this.proxy?.server.close();
    this.proxy = undefined;
  }

  private serve(experiments: HarnessExperiments) {
    const model = experiments.semanticGrep ? hostedEmbeddingModel(experiments.embeddingModel) : undefined;
    if (this.proxy?.model.id === model?.id) return;
    this.closeProxy();
    if (!model) return;
    const token = randomBytes(24).toString("hex");
    const server = embeddingProxy(model, token, () => process.env[model.credentialEnv]?.trim() ?? "");
    const proxy = { server, model, token, error: "" };
    server.once("error", (error) => { proxy.error = error.message; this.onChange(); });
    server.listen(this.port, "127.0.0.1");
    this.proxy = proxy;
  }

  private endpoint() {
    return `http://127.0.0.1:${this.port}/v1/embeddings`;
  }

  private embedding(model: string): Embedding {
    const home = { name: "ZVEC_GREP_HOME", value: zvecHome() };
    if (!this.proxy) return [home, { name: "ZVEC_GREP_EMBEDDING", value: model }];
    return [
      home,
      { name: "ZVEC_GREP_EMBEDDING", value: REMOTE_MODEL },
      { name: "ZVEC_GREP_ENDPOINT", value: this.endpoint() },
      { name: "ZVEC_GREP_API_KEY", value: this.proxy.token },
    ];
  }

  private env(): Record<string, string> {
    const embedding = this.experiments ? this.embedding(this.experiments.embeddingModel) : [];
    const inherited = Object.entries(process.env).filter(([name, value]) => value !== undefined && (KEEP_ENV.has(name) || name.startsWith("ZVEC_GREP_"))) as [string, string][];
    return { ...Object.fromEntries(inherited), ELECTRON_RUN_AS_NODE: "1", ZVEC_GREP_HOME: zvecHome(), ...Object.fromEntries(embedding.map((item) => [item.name, item.value])) };
  }

  private run(args: string[], extra: Record<string, string> = {}) {
    return spawn(this.node, [this.entry, ...args], { env: { ...this.env(), ...extra }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  }

  private restartDaemon(experiments: HarnessExperiments) {
    this.stopDaemon().once("close", () => {
      if (this.experiments === experiments && experiments.semanticGrep) this.daemon("on");
    });
  }

  private stopDaemon() {
    return this.daemon("off");
  }

  private daemon(action: "on" | "off") {
    const tokenFile = action === "on" ? daemonTokenFile() : "";
    const child = this.run(["server", action], tokenFile ? { ZVEC_GREP_SERVER_TOKEN_FILE: tokenFile } : {});
    child.stdout?.resume();
    child.stderr?.resume();
    child.once("error", () => undefined);
    return child;
  }

  private revoke(root: string) {
    const child = this.run(["auth", "revoke", root]);
    child.stdout?.resume();
    child.stderr?.resume();
    child.once("error", () => undefined);
  }

  private fail(root: string, detail: string) {
    const folder = this.folders.get(root);
    this.failedAt.set(root, Date.now());
    if (folder?.state === "failed" && folder.detail === detail) return;
    this.folders.set(root, { path: root, model: this.experiments?.embeddingModel ?? "", state: "failed", detail, done: 0, total: 0, left: 0 });
    this.onChange();
  }

  private index(root: string, model: string) {
    const folder: SemanticGrepFolder = { path: root, model, state: "indexing", detail: "", done: 0, total: 0, left: 0 };
    const started = Date.now();
    let notified = 0;
    this.folders.set(root, folder);
    this.onChange();
    void ignoreIndexDir(root);
    const rebuild = this.rebuild.delete(root) ? ["--rebuild"] : [];
    const device = process.platform === "darwin" && process.arch === "arm64" && LLAMA_MODELS.has(model) ? ["--device", "metal"] : [];
    const remote = this.proxy ? ["--embedding", REMOTE_MODEL] : ["--embedding", model];
    const steps = this.proxy
      ? [["auth", "grant", "--capability", "embedding", "--scope", "workspace", root, ...remote], ["index", root, ...remote, "--allow-remote", "--mode", "auto", "--embedding-concurrency", CONCURRENCY, ...rebuild]]
      : [["index", root, ...remote, "--mode", "auto", "--embedding-concurrency", CONCURRENCY, ...device, ...rebuild]];
    const step = (at: number) => {
      const child = this.run(steps[at]);
      this.children.set(root, child);
      let err = "";
      child.stdout?.resume();
      child.stderr?.on("data", (data: Buffer) => {
        err = (err + String(data)).slice(-4096);
        const detail = String(data).split("\n").map((line) => line.trim()).filter((line) => DETAIL_LINE.test(line)).pop();
        const progress = indexProgress(String(data));
        if (detail) folder.detail = detail;
        if (progress) {
          const elapsed = Date.now() - started;
          folder.done = progress.done;
          folder.total = progress.total;
          folder.left = progress.done && (progress.done >= ESTIMATE_AFTER_FILES || elapsed >= ESTIMATE_AFTER_MS) ? Math.round(((progress.total - progress.done) * elapsed) / progress.done / 1000) : 0;
        }
        if (!detail && !progress) return;
        if (Date.now() - notified < 1000) return;
        notified = Date.now();
        this.onChange();
      });
      child.once("error", (error) => {
        if (this.folders.get(root) !== folder) return;
        folder.state = "failed";
        folder.detail = error.message;
        this.failedAt.set(root, Date.now());
        this.onChange();
      });
      child.once("close", (code) => {
        if (this.children.get(root) === child) this.children.delete(root);
        if (this.folders.get(root) !== folder) return;
        if (code === 0 && at + 1 < steps.length) return step(at + 1);
        folder.state = code === 0 ? "ready" : "failed";
        folder.left = 0;
        if (code === 0 && folder.total) folder.done = folder.total;
        folder.detail = code === 0 ? "" : (failureDetail(err) || `zg ${steps[at][0]} exited with ${code}`);
        if (code !== 0) this.failedAt.set(root, Date.now());
        this.onChange();
      });
    };
    step(0);
  }
}

export async function ignoreIndexDir(root: string) {
  const dir = path.join(root, INDEX_DIR);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, ".gitignore"), "*\n");
  } catch {
    return;
  }
}
