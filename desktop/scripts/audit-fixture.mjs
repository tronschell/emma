import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { appendFile, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

const [action, argument, port] = process.argv.slice(2);
if (action === "seed") {
  assert.ok(argument, "Pass a freshly built emma-host binary");
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "emma-audit-mock-")));
  const fixture = Object.fromEntries(["data", "profile", "home", "workspace"].map((name) => [name, path.join(root, name)]));
  for (const directory of Object.values(fixture)) await mkdir(directory, { recursive: true });
  const marker = path.join(fixture.workspace, "permission-marker.txt");
  const longPath = path.join(fixture.workspace, "long-path-".repeat(14), "nested-path-".repeat(14), "tracked.txt");
  await mkdir(path.dirname(longPath), { recursive: true });
  await writeFile(longPath, "Original long-path contents\n");
  await writeFile(path.join(fixture.workspace, "tracked.txt"), "Original tracked contents\n");
  await writeFile(path.join(fixture.workspace, "alpha.txt"), "Alpha attachment: preserve this association.\n");
  await writeFile(path.join(fixture.workspace, "beta.txt"), "Beta attachment: belongs to the next prompt.\n");
  const tool = path.join(fixture.profile, "tools", "audit_marker");
  await mkdir(tool, { recursive: true });
  await writeFile(path.join(tool, "about.txt"), "Append a harmless audit marker inside this disposable test workspace.");
  await writeFile(path.join(tool, "run"), `#!/bin/sh\nprintf 'approved\\n' >> '${marker.replaceAll("'", "'\\''")}'\nprintf 'audit marker recorded\\n'\n`, { mode: 0o700 });
  const folderId = randomUUID();
  await writeFile(path.join(fixture.profile, "folders.json"), JSON.stringify([{ id: folderId, path: fixture.workspace, name: "Audit mock workspace" }]));
  const child = spawn(path.resolve(argument), [], { env: { PATH: process.env.PATH, HOME: fixture.home, EMMA_DATA_DIR: fixture.data }, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  let id = 0;
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const response = JSON.parse(line);
    const waiter = pending.get(response.id);
    if (!waiter) return;
    pending.delete(response.id);
    if (response.ok) waiter.resolve(response.result);
    else waiter.reject(new Error(response.error));
  });
  child.on("error", (error) => { for (const waiter of pending.values()) waiter.reject(error); });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const key = String(++id);
    pending.set(key, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ id: key, method, params })}\n`);
  });
  const threads = [];
  for (const title of ["Audit composer history", "Audit empty composer", "Audit harness checks"]) threads.push(await request("createThread", { title }));
  for (const prompt of ["Earlier audit prompt one", "Earlier audit prompt two"]) await request("recordTurn", { threadId: threads[0].id, prompt, response: `Saved mock reply to ${prompt}.`, model: "audit/local" });
  const job = await request("saveScheduledJob", { jobId: "", title: "Audit disabled schedule", schedule: "0 9 * * 1", prompt: "Mock schedule only", nodes: "", sourceDomains: "[]", permissionMode: "ask", model: "" });
  await request("setScheduledJobEnabled", { jobId: job.id, enabled: "false" });
  const snapshot = await request("snapshot");
  assert.equal(snapshot.threads.length, 3);
  assert.equal(snapshot.threads.find((thread) => thread.id === threads[0].id).messages.length, 4);
  assert.equal(snapshot.scheduledJobs[0].enabled, false);
  child.stdin.end();
  const [code] = await once(child, "exit");
  assert.equal(code, 0, stderr);
  assert.equal(stderr, "");
  const manifest = { root, ...fixture, folderId, marker, longPath, threads: threads.map(({ id, title }) => ({ id, title })), jobId: job.id };
  const file = path.join(root, "fixture.json");
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(file);
} else if (action === "serve") {
  const fixture = JSON.parse(await readFile(argument, "utf8"));
  const log = path.join(fixture.root, "provider.jsonl");
  const flatten = (content) => typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part.text ?? "").join("\n") : "";
  let count = 0;
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "audit/local", object: "model" }, { id: "audit/verifier", object: "model" }] }));
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        response.writeHead(404).end();
        return;
      }
      let raw = "";
      for await (const chunk of request) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw new Error("Mock request exceeds fixture limit");
      }
      const body = JSON.parse(raw);
      assert.ok(Array.isArray(body.messages));
      const lastUser = body.messages.findLastIndex((message) => message.role === "user");
      const prompt = flatten(body.messages[lastUser]?.content);
      const alreadyUsedTool = body.messages.slice(lastUser + 1).some((message) => message.role === "tool");
      const marker = prompt.match(/\[audit:([a-z-]+)\]/)?.[1] ?? "reply";
      const requestId = ++count;
      await appendFile(log, `${JSON.stringify({ requestId, model: body.model, marker, alreadyUsedTool, alpha: prompt.includes("Alpha attachment: preserve this association."), beta: prompt.includes("Beta attachment: belongs to the next prompt."), at: new Date().toISOString() })}\n`);
      let message = { role: "assistant", content: `Mock response ${requestId}: ${marker}.` };
      if (body.model === "audit/verifier") {
        await new Promise((resolve) => setTimeout(resolve, 7000));
        message.content = JSON.stringify({ allow: true, reason: "Harmless isolated audit fixture action." });
      } else if (marker === "queue") {
        await new Promise((resolve) => setTimeout(resolve, 30000));
      } else if (!alreadyUsedTool && ["edit", "edit-long", "own", "native", "mode-own", "mode-native"].includes(marker)) {
        if (marker.startsWith("mode-")) await new Promise((resolve) => setTimeout(resolve, 6000));
        const name = marker.includes("own") ? "run_tool" : marker.includes("native") ? "terminal" : "write_file";
        const args = name === "run_tool" ? { name: "audit_marker" } : name === "terminal" ? { action: "exec", command: `printf 'native approved\\n' >> '${fixture.marker.replaceAll("'", "'\\''")}'` } : { content: marker === "edit-long" ? "Audited long write.\n".repeat(600) : "Audited replacement contents\n", path: marker === "edit-long" ? fixture.longPath : path.join(fixture.workspace, "tracked.txt") };
        message = { role: "assistant", content: "Running the isolated mock check.", tool_calls: [{ id: `audit_${requestId}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: `audit_${requestId}`, object: "chat.completion", model: body.model, choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
    } catch (error) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: String(error) } }));
    }
  });
  server.listen(port ? Number(port) : 0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  await writeFile(path.join(fixture.root, "provider.json"), JSON.stringify({ baseUrl, model: "audit/local", verifier: "audit/verifier", log }, null, 2));
  console.log(JSON.stringify({ baseUrl, model: "audit/local", verifier: "audit/verifier", log }));
  process.on("SIGINT", () => server.close());
  process.on("SIGTERM", () => server.close());
} else {
  throw new Error("Usage: node audit-fixture.mjs seed /absolute/emma-host | serve /absolute/fixture.json [port]");
}
