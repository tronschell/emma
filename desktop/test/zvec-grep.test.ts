import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ZVEC_GREP_ENTRY, ZVEC_GREP_VERSION, zvecGrepAsset, zvecGrepPercent, zvecGrepProgressLabel, zvecGrepUrl } from "../shared/zvec-grep";
import { extractTarGz, tarEntryPath, ZvecGrepTool } from "../main/zvec-grep";

const DEEP = "node_modules/@zvec/zvec-grep/dist/cli/very/deeply/nested/directory/that/pushes/the/entry/name/past/one/hundred/characters/leaf.txt";

async function fixture(): Promise<{ root: string; tarball: string; digest: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "emma-zvec-fixture-"));
  const tree = path.join(root, "tree");
  const entry = path.join(tree, ZVEC_GREP_ENTRY);
  mkdirSync(path.dirname(entry), { recursive: true });
  writeFileSync(entry, "console.log('zg');\n");
  mkdirSync(path.dirname(path.join(tree, DEEP)), { recursive: true });
  writeFileSync(path.join(tree, DEEP), "deep\n");
  const tarball = path.join(root, zvecGrepAsset(process.platform, process.arch));
  execFileSync("tar", ["-czf", tarball, "-C", tree, "."]);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(tarball)) hash.update(chunk);
  return { root, tarball, digest: hash.digest("hex") };
}

function serve(tarball: string, digest: string): Promise<{ origin: string; hits: () => number; close: () => void }> {
  let hits = 0;
  const asset = zvecGrepAsset(process.platform, process.arch);
  const server = http.createServer((request, response) => {
    hits += 1;
    if (request.url?.endsWith(".sha256")) {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(`${digest}  ${asset}\n`);
      return;
    }
    if (!request.url?.endsWith(asset)) {
      response.writeHead(404).end();
      return;
    }
    const body = readFileSync(tarball);
    response.writeHead(200, { "content-type": "application/gzip", "content-length": String(body.length) });
    response.end(body);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const { port } = server.address() as net.AddressInfo;
    resolve({ origin: `http://127.0.0.1:${port}`, hits: () => hits, close: () => server.close() });
  }));
}

function settled(root: string, origin: string): Promise<ZvecGrepTool> {
  return new Promise((resolve) => {
    const tool: ZvecGrepTool = new ZvecGrepTool(root, origin, () => {
      if (tool.status().phase === "ready" || tool.status().phase === "failed") resolve(tool);
    });
    tool.install();
  });
}

test("a tar entry may not escape the directory it unpacks into", () => {
  assert.equal(tarEntryPath("/tools", "./"), "");
  assert.equal(tarEntryPath("/tools", "node_modules/@zvec/index.js"), path.resolve("/tools", "node_modules/@zvec/index.js"));
  assert.throws(() => tarEntryPath("/tools", "/etc/passwd"), /absolute path/);
  assert.throws(() => tarEntryPath("/tools", "C:/Windows/System32/evil.dll"), /absolute path/);
  assert.throws(() => tarEntryPath("/tools", "../../escaped.js"), /escapes its directory/);
  assert.throws(() => tarEntryPath("/tools", "node_modules/../../escaped.js"), /escapes its directory/);
});

test("the download URL and its checksum sit under the tools release for this platform", () => {
  assert.equal(zvecGrepUrl("https://github.com", "win32", "x64"), `https://github.com/tronschell/emma/releases/download/zvec-grep-v${ZVEC_GREP_VERSION}/zvec-grep-${ZVEC_GREP_VERSION}-win32-x64.tar.gz`);
  assert.equal(zvecGrepAsset("darwin", "arm64"), `zvec-grep-${ZVEC_GREP_VERSION}-darwin-arm64.tar.gz`);
  assert.equal(zvecGrepProgressLabel({ phase: "ready", version: ZVEC_GREP_VERSION, bytes: 0, total: 0, detail: "" }), `Installed · v${ZVEC_GREP_VERSION}`);
  assert.equal(zvecGrepProgressLabel({ phase: "downloading", version: ZVEC_GREP_VERSION, bytes: 5 * 1024 * 1024, total: 20 * 1024 * 1024, detail: "" }), "5 MB of 20 MB");
  assert.equal(Math.round(zvecGrepPercent({ phase: "downloading", version: ZVEC_GREP_VERSION, bytes: 5, total: 20, detail: "" })), 25);
});

test("a tar.gz unpacks entries whose names outrun the ustar header", async () => {
  const built = await fixture();
  const into = path.join(built.root, "out");
  await extractTarGz(createReadStream(built.tarball), into, () => false);
  assert.equal(readFileSync(path.join(into, ZVEC_GREP_ENTRY), "utf8"), "console.log('zg');\n");
  assert.equal(readFileSync(path.join(into, DEEP), "utf8"), "deep\n");
  await rm(built.root, { recursive: true, force: true });
});

test("the tool downloads once, verifies its checksum, and a later launch reuses the install", async () => {
  const built = await fixture();
  const server = await serve(built.tarball, built.digest);
  const root = path.join(built.root, "tools");
  const installed = await settled(root, server.origin);
  assert.equal(installed.status().phase, "ready");
  assert.equal(installed.status().version, ZVEC_GREP_VERSION);
  assert.equal(installed.entry(), path.join(root, ZVEC_GREP_VERSION, ZVEC_GREP_ENTRY));
  assert.equal(existsSync(path.join(root, ZVEC_GREP_VERSION, DEEP)), true);
  const downloads = server.hits();
  const relaunched = new ZvecGrepTool(root, server.origin, () => undefined);
  assert.equal(relaunched.status().phase, "ready");
  relaunched.install();
  assert.equal(server.hits(), downloads);
  server.close();
  await rm(built.root, { recursive: true, force: true });
});

test("a download that does not match its checksum leaves nothing installed", async () => {
  const built = await fixture();
  const server = await serve(built.tarball, "0".repeat(64));
  const root = path.join(built.root, "tools");
  const tool = await settled(root, server.origin);
  assert.equal(tool.status().phase, "failed");
  assert.match(tool.status().detail, /checksum/);
  assert.equal(tool.entry(), "");
  server.close();
  await rm(built.root, { recursive: true, force: true });
});
