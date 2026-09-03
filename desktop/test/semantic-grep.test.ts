import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { embeddingProxy, failureDetail, ignoreIndexDir, proxyPort, SemanticGrep, semanticGrepOption, zvecHome } from "../main/semantic-grep";
import { indexProgress, progressLabel, timeLeft } from "../shared/semantic-grep";
import { defaultHarnessExperiments, hostedEmbeddingModel, type HarnessExperiments } from "../shared/settings";

const hosted: HarnessExperiments = { ...defaultHarnessExperiments, semanticGrep: true, embeddingModel: "hosted/openrouter/google/gemini-embedding-001" };

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

function listen(server: http.Server, port = 0): Promise<number> {
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port)));
}

test("the semantic_grep option names the app binary as node and carries the embedding model", () => {
  const option = JSON.parse(semanticGrepOption("/Applications/Emma.app/Contents/MacOS/Emma", "/res/zvec-grep/index.js", [{ name: "ZVEC_GREP_EMBEDDING", value: "local/potion-code-16m-v2" }]));
  assert.equal(option.command, "/Applications/Emma.app/Contents/MacOS/Emma");
  assert.deepEqual(option.args, ["/res/zvec-grep/index.js"]);
  assert.deepEqual(option.env, [{ name: "ELECTRON_RUN_AS_NODE", value: "1" }, { name: "ZVEC_GREP_EMBEDDING", value: "local/potion-code-16m-v2" }]);
});

test("the option is empty when the toggle is off or zvec-grep is not bundled", () => {
  const changes: number[] = [];
  const bundled = new SemanticGrep("/node", "/entry.js", true, 0, () => changes.push(1));
  assert.equal(bundled.option(defaultHarnessExperiments), "");
  assert.equal(bundled.option({ ...defaultHarnessExperiments, semanticGrep: true }).length > 0, true);
  const missing = new SemanticGrep("/node", "/entry.js", false, 0, () => changes.push(1));
  assert.equal(missing.option({ ...defaultHarnessExperiments, semanticGrep: true }), "");
  assert.deepEqual(missing.status(), { available: false, enabled: false, model: "", folders: [] });
  assert.equal(changes.length, 0);
});

test("a hosted model without its key leaves the option empty and names the key on the folder", () => {
  delete process.env.OPENROUTER_API_KEY;
  const changes: number[] = [];
  const grep = new SemanticGrep("/node", "/entry.js", true, 0, () => changes.push(1));
  grep.apply(hosted);
  assert.equal(grep.option(hosted), "");
  assert.equal(grep.option(hosted, "/work/app"), "");
  assert.equal(grep.status().model, hosted.embeddingModel);
  assert.deepEqual(grep.status().folders, [{ path: "/work/app", model: hosted.embeddingModel, state: "failed", detail: "Needs OPENROUTER_API_KEY", done: 0, total: 0, left: 0 }]);
  grep.stop();
});

test("a hosted model with its key points zg at the loopback proxy under a per-launch token", async () => {
  process.env.OPENROUTER_API_KEY = "sk-or-test";
  const port = await freePort();
  const grep = new SemanticGrep("/node", "/entry.js", true, port, () => undefined);
  grep.apply(hosted);
  const env = Object.fromEntries((JSON.parse(grep.option(hosted)).env as { name: string; value: string }[]).map((item) => [item.name, item.value]));
  assert.equal(env.ZVEC_GREP_EMBEDDING, "qwen/text-embedding-v4");
  assert.equal(env.ZVEC_GREP_ENDPOINT, `http://127.0.0.1:${port}/v1/embeddings`);
  assert.equal(env.ZVEC_GREP_HOME, path.join(os.homedir(), ".zvec-grep"));
  assert.equal(zvecHome(), env.ZVEC_GREP_HOME);
  assert.match(env.ZVEC_GREP_API_KEY, /^[0-9a-f]{48}$/);
  const denied = await fetch(env.ZVEC_GREP_ENDPOINT, { method: "POST", headers: { authorization: "Bearer wrong" }, body: "{}" });
  assert.equal(denied.status, 401);
  grep.stop();
  delete process.env.OPENROUTER_API_KEY;
});

test("the proxy rewrites the model, drops dimensions the upstream does not take, truncates and normalizes", async () => {
  const seen: unknown[] = [];
  const upstream = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      seen.push({ authorization: req.headers.authorization, body: JSON.parse(body) });
      const embedding = Array.from({ length: 3072 }, (_, i) => i + 1);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ object: "list", data: [{ object: "embedding", index: 0, embedding }], model: "gemini-embedding-001", usage: { prompt_tokens: 3, total_tokens: 3 } }));
    });
  });
  const upstreamPort = await listen(upstream);
  const model = { ...hostedEmbeddingModel("hosted/openrouter/google/gemini-embedding-001")!, endpoint: `http://127.0.0.1:${upstreamPort}/v1/embeddings` };
  const proxy = embeddingProxy(model, "token", () => "sk-or-real");
  const proxyPort = await listen(proxy);
  const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/embeddings`, { method: "POST", headers: { authorization: "Bearer token", "content-type": "application/json" }, body: JSON.stringify({ model: "text-embedding-v4", input: ["hello"], dimensions: 1024, encoding_format: "float" }) });
  assert.equal(response.status, 200);
  const json = (await response.json()) as { data: { index: number; embedding: number[] }[]; model: string };
  assert.deepEqual(seen, [{ authorization: "Bearer sk-or-real", body: { model: "google/gemini-embedding-001", input: ["hello"], encoding_format: "float" } }]);
  assert.equal(json.data[0].embedding.length, 1024);
  const norm = Math.sqrt(json.data[0].embedding.reduce((sum, n) => sum + n * n, 0));
  assert.ok(Math.abs(norm - 1) < 1e-9);
  assert.ok(Math.abs(json.data[0].embedding[1023] / json.data[0].embedding[0] - 1024) < 1e-9);
  proxy.close();
  upstream.close();
});

test("the proxy keeps dimensions for OpenAI text-embedding-3 and refuses vectors under 1024", async () => {
  const bodies: { dimensions?: number }[] = [];
  const upstream = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      bodies.push(JSON.parse(body));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ index: 0, embedding: [1, 2, 3] }] }));
    });
  });
  const upstreamPort = await listen(upstream);
  const model = { ...hostedEmbeddingModel("hosted/openai/text-embedding-3-small")!, endpoint: `http://127.0.0.1:${upstreamPort}/v1/embeddings` };
  const proxy = embeddingProxy(model, "token", () => "sk-real");
  const proxyPort = await listen(proxy);
  const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/embeddings`, { method: "POST", headers: { authorization: "Bearer token" }, body: JSON.stringify({ model: "text-embedding-v4", input: ["hello"], dimensions: 1024 }) });
  assert.equal(response.status, 502);
  assert.match(((await response.json()) as { error: { message: string } }).error.message, /3 dimensions/);
  assert.equal(bodies[0].dimensions, 1024);
  proxy.close();
  upstream.close();
});

test("the proxy port is stable per data directory and inside the unprivileged range", () => {
  assert.equal(proxyPort("/Users/a/Library/Application Support/Emma"), proxyPort("/Users/a/Library/Application Support/Emma"));
  assert.notEqual(proxyPort("/a"), proxyPort("/b"));
  for (const seed of ["/a", "/b", "/c"]) assert.ok(proxyPort(seed) >= 20000 && proxyPort(seed) < 60000);
});

test("index progress is read off the last zg stderr line and labelled with the time left", () => {
  assert.deepEqual(indexProgress("Scanning files...\nIndexing files: 12/1904 src/a.ts\nIndexing files: 781/1904 src/b.ts\n"), { done: 781, total: 1904 });
  assert.equal(indexProgress("Model ready: local/potion-code-16m-v2\n"), undefined);
  assert.equal(timeLeft(0), "");
  assert.equal(timeLeft(40), "under a minute left");
  assert.equal(timeLeft(130), "about 2 min left");
  assert.equal(timeLeft(5400), "about 1.5 h left");
  assert.equal(timeLeft(7200), "about 2 h left");
  assert.equal(progressLabel({ path: "/w", model: "", state: "indexing", detail: "", done: 781, total: 1904, left: 130 }), "781 / 1,904 · about 2 min left");
  assert.equal(progressLabel({ path: "/w", model: "", state: "indexing", detail: "", done: 0, total: 0, left: 0 }), "scanning files");
  assert.equal(progressLabel({ path: "/w", model: "", state: "indexing", detail: "Downloading local/embeddinggemma-300m · 42%", done: 0, total: 0, left: 0 }), "Downloading local/embeddinggemma-300m · 42%");
  assert.equal(progressLabel({ path: "/w", model: "", state: "ready", detail: "", done: 60, total: 60, left: 0 }), "60 files");
  assert.equal(progressLabel({ path: "/w", model: "", state: "failed", detail: "Needs OPENROUTER_API_KEY", done: 0, total: 0, left: 0 }), "Needs OPENROUTER_API_KEY");
});

test("a local model carries the shared zvec-grep home and no proxy credentials", () => {
  const grep = new SemanticGrep("/node", "/entry.js", true, 0, () => undefined);
  const local = { ...defaultHarnessExperiments, semanticGrep: true };
  grep.apply(local);
  const env = Object.fromEntries((JSON.parse(grep.option(local)).env as { name: string; value: string }[]).map((item) => [item.name, item.value]));
  assert.equal(env.ZVEC_GREP_HOME, zvecHome());
  assert.equal(env.ZVEC_GREP_EMBEDDING, local.embeddingModel);
  assert.equal(env.ZVEC_GREP_API_KEY, undefined);
  assert.equal(env.ZVEC_GREP_ENDPOINT, undefined);
  grep.stop();
});

test("a proxy that cannot bind leaves the option empty and fails the folder", async () => {
  process.env.OPENROUTER_API_KEY = "sk-or-test";
  const port = await freePort();
  const squatter = http.createServer();
  await listen(squatter, port);
  const grep = new SemanticGrep("/node", "/entry.js", true, port, () => undefined);
  grep.apply(hosted);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(grep.option(hosted), "");
  assert.equal(grep.option(hosted, "/work/app"), "");
  assert.match(grep.status().folders[0].detail, /^Embedding proxy: /);
  grep.stop();
  squatter.close();
  delete process.env.OPENROUTER_API_KEY;
});

test("the failure detail is the first error line, not the last stderr line", () => {
  assert.equal(failureDetail("Scanning files...\nError: embedding endpoint refused the connection\n  ownerHost: mac.local\n  pid: 1234\n"), "Error: embedding endpoint refused the connection");
  assert.equal(failureDetail("zvec-grep failed\nownerHost: mac.local\n"), "zvec-grep failed");
  assert.equal(failureDetail("   \n\n"), "");
});

test("the index directory ignores itself instead of touching the folder's git exclude", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zg-"));
  await ignoreIndexDir(root);
  assert.equal(await readFile(path.join(root, ".zvec-grep", ".gitignore"), "utf8"), "*\n");
  await ignoreIndexDir(root);
  assert.equal(await readFile(path.join(root, ".zvec-grep", ".gitignore"), "utf8"), "*\n");
  await rm(root, { recursive: true, force: true });
});
