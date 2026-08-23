import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ImportedCapabilityRuntime, listEmmaTools, parseMcpConfig, seedBuiltinSkills, SkillAttachmentStore, writeEmmaTool } from "../main/capabilities";
import { shellQuoted } from "../main/tools";

test("bundled skills are seeded into both skill roots and are searchable without an import", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "emma-builtin-"));
  try {
    const builtin = path.join(root, "bundle");
    const userData = path.join(root, "user-data");
    const harnessHome = path.join(userData, "harness");
    await mkdir(path.join(builtin, "building-emma"), { recursive: true });
    await mkdir(path.join(builtin, "not-a-skill"), { recursive: true });
    await writeFile(path.join(builtin, "building-emma", "SKILL.md"), "---\nname: building-emma\n---\nRebuild, then verify.");

    assert.deepEqual(await seedBuiltinSkills(builtin, userData, harnessHome), ["building-emma"]);
    assert.equal(await readFile(path.join(harnessHome, ".fx", "skills", "building-emma", "SKILL.md"), "utf8"), "---\nname: building-emma\n---\nRebuild, then verify.");

    const runtime = new ImportedCapabilityRuntime(userData);
    const [found] = await runtime.searchSkills("build");
    assert.deepEqual(found, { id: "skill:emma:0:building-emma", source: "emma", name: "building-emma" });
    assert.match((await runtime.selectSkill(found.id)).instructions, /Rebuild, then verify\./);
    await runtime.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skill attachments are one-turn, retryable, and bound to their thread", () => {
  const store = new SkillAttachmentStore();
  const skill = { id: "skill:codex:0:review", source: "codex", name: "review", instructions: "Review carefully." };
  store.put(skill, "thread-123456789012");
  assert.equal(store.status()?.threadId, "thread-123456789012");
  assert.throws(() => store.claim(skill.id, "thread-000000000000"), /unavailable/);
  assert.equal(store.claim(skill.id, "thread-123456789012").instructions, skill.instructions);
  store.finish(skill.id, false);
  assert.equal(store.claim(skill.id, "thread-123456789012").name, "review");
  store.finish(skill.id, true);
  assert.equal(store.status(), null);
});

test("imported skills stay metadata-only until selected", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "emma-capabilities-"));
  try {
    const skillRoot = path.join(root, "skills");
    const userData = path.join(root, "user-data");
    await mkdir(path.join(skillRoot, "review"), { recursive: true });
    await mkdir(userData, { recursive: true });
    await writeFile(path.join(skillRoot, "review", "SKILL.md"), "secret skill instructions");
    await writeFile(path.join(userData, "imports.json"), JSON.stringify({ version: 1, sources: [{ id: "codex", skillRoots: [skillRoot], mcpFiles: [] }] }));

    const runtime = new ImportedCapabilityRuntime(userData);
    const results = await runtime.searchSkills("review");
    assert.deepEqual(results, [{ id: "skill:codex:0:review", source: "codex", name: "review" }]);
    assert.equal(JSON.stringify(results).includes("secret"), false);
    assert.deepEqual(await runtime.selectSkill(results[0].id), { id: results[0].id, source: "codex", name: "review", instructions: "secret skill instructions" });
    await runtime.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a tool Emma writes is executable, listed with its description, and replaced by name", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "emma-tools-"));
  try {
    const written = await writeEmmaTool(root, "count-lines", "Counts the lines of the file named in its input.", "#!/bin/sh\nwc -l < \"$1\"\n");
    assert.deepEqual(await listEmmaTools(root), [written]);

    // The whole point: it runs, exactly the way main runs it, with the input as
    // its one argument — the file here has a quote in its name on purpose.
    const sample = path.join(root, "it's a sample.txt");
    await writeFile(sample, "a\nb\nc\n");
    const { stdout } = await promisify(execFile)("/bin/bash", ["-lc", `${shellQuoted(written.run)} ${shellQuoted(sample)}`], { cwd: root });
    assert.equal(stdout.trim(), "3");

    // Same name replaces it, which is how a tool that turned out wrong gets fixed.
    const fixed = await writeEmmaTool(root, "count-lines", "Counts lines, words and bytes.", "#!/bin/sh\nwc \"$1\"\n");
    assert.equal((await listEmmaTools(root)).length, 1);
    assert.equal((await listEmmaTools(root))[0].description, fixed.description);

    await assert.rejects(() => writeEmmaTool(root, "count-lines", "No interpreter.", "wc -l < \"$1\"\n"), /#!/);
    await assert.rejects(() => writeEmmaTool(root, "../escape", "Outside the folder.", "#!/bin/sh\n:\n"), /invalid/);
    // A tool root that does not exist yet is an empty list, not a failure.
    assert.deepEqual(await listEmmaTools(path.join(root, "nothing-here")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one selected stdio MCP server is reviewed, searched, selected, called, and cleaned up", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "emma-mcp-"));
  const runtime = new ImportedCapabilityRuntime(path.join(root, "user-data"));
  try {
    const userData = path.join(root, "user-data");
    const config = path.join(root, "claude.json");
    await mkdir(userData, { recursive: true });
    const serverProgram = [
      "const readline=require('node:readline');",
      "const rl=readline.createInterface({input:process.stdin});",
      "const send=(value)=>process.stdout.write(JSON.stringify(value)+'\\n');",
      "rl.on('line',(line)=>{const request=JSON.parse(line);",
      "if(request.method==='initialize')send({jsonrpc:'2.0',id:request.id,result:{protocolVersion:'2024-11-05',capabilities:{},serverInfo:{name:'fixture',version:'1'}}});",
      "if(request.method==='tools/list')send({jsonrpc:'2.0',id:request.id,result:{tools:[{name:'echo',description:'Echo selected text',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]}});",
      "if(request.method==='tools/call')send({jsonrpc:'2.0',id:request.id,result:{content:[{type:'text',text:request.params.arguments.text}]}});",
      "});",
    ].join("");
    await writeFile(config, JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: ["-e", serverProgram], env: { MCP_SECRET: "do-not-render" } } } }));
    await writeFile(path.join(userData, "imports.json"), JSON.stringify({ version: 1, sources: [{ id: "claude", skillRoots: [], mcpFiles: [config] }] }));

    const servers = await runtime.listMcpServers();
    assert.equal(servers.length, 1);
    assert.equal(servers[0].command, process.execPath);
    assert.deepEqual(servers[0].args, ["-e", "[argument 2 redacted]"]);
    assert.equal(JSON.stringify(servers).includes("do-not-render"), false);
    const review = await runtime.permissionReview(servers[0].id);
    assert.deepEqual(review.environmentKeys, ["MCP_SECRET"]);
    assert.equal(review.args[0], "-e");
    assert.equal(typeof review.token, "string");
    assert.equal(JSON.stringify(review).includes("do-not-render"), false);
    const token = review.token;
    assert.deepEqual(await runtime.connect(servers[0].id, token), { server: servers[0], tools: 1 });
    await assert.rejects(() => runtime.connect(servers[0].id, token), /invalid or expired/);
    assert.deepEqual(await runtime.searchTools("echo"), [{ name: "echo", description: "Echo selected text" }]);
    assert.deepEqual(await runtime.selectTool("echo"), { name: "echo", description: "Echo selected text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } });
    assert.deepEqual(await runtime.callTool({ text: "hello" }), { content: [{ type: "text", text: "hello" }] });
    await runtime.close();
    await assert.rejects(async () => runtime.searchTools("echo"), /connect one MCP server/);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an installed MCP server is listed and callable with no import and no relaunch", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "emma-install-mcp-"));
  const userData = path.join(root, "user-data");
  const runtime = new ImportedCapabilityRuntime(userData);
  try {
    const program = [
      "const readline=require('node:readline');",
      "const rl=readline.createInterface({input:process.stdin});",
      "const send=(value)=>process.stdout.write(JSON.stringify(value)+'\\n');",
      "rl.on('line',(line)=>{const request=JSON.parse(line);",
      "if(request.method==='initialize')send({jsonrpc:'2.0',id:request.id,result:{protocolVersion:'2024-11-05',capabilities:{}}});",
      "if(request.method==='tools/list')send({jsonrpc:'2.0',id:request.id,result:{tools:[{name:'whoami',description:'Name the server',inputSchema:{type:'object',properties:{}}}]}});",
      "if(request.method==='tools/call')send({jsonrpc:'2.0',id:request.id,result:{content:[{type:'text',text:process.env.WHO}]}});",
      "});",
    ].join("");
    const definition = { name: "fixture", command: process.execPath, args: ["-e", program], env: { WHO: "installed" } };

    // No imports.json at all: Emma's own config is the whole install.
    const installed = await runtime.installMcpServer(definition);
    assert.equal(installed.id, "mcp:emma:0:fixture");
    assert.equal(installed.tools, 1);
    assert.equal(runtime.connected, true);

    // Live in the same process the tool was advertised in, and callable straight away.
    assert.deepEqual(await runtime.searchTools("whoami"), [{ name: "whoami", description: "Name the server" }]);
    assert.deepEqual(await runtime.selectTool("whoami"), { name: "whoami", description: "Name the server", inputSchema: { type: "object", properties: {} } });
    assert.deepEqual(await runtime.callTool({}), { content: [{ type: "text", text: "installed" }] });

    // A fresh runtime, standing in for a relaunch, sees the same server without an import.
    const listed = await new ImportedCapabilityRuntime(userData).listMcpServers();
    assert.deepEqual(listed.map((server) => server.id), ["mcp:emma:0:fixture"]);
    assert.deepEqual(listed[0].environmentKeys, ["WHO"]);
    assert.equal(JSON.stringify(listed).includes("installed"), false);

    // Reinstalling the same name replaces it rather than adding a second entry.
    await runtime.installMcpServer(definition);
    assert.equal((await runtime.listMcpServers()).length, 1);
    await assert.rejects(() => runtime.installMcpServer({ ...definition, name: "not a name" }), /not valid/);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex-style MCP TOML stays main-side and supports stdio metadata", () => {
  const [server] = parseMcpConfig('[mcp_servers."fixture"]\ncommand = "node"\nargs = ["server.js"]\nenv = { API_KEY = "secret" }\n', "config.toml", "codex", 0);
  assert.equal(server.id, "mcp:codex:0:fixture");
  assert.deepEqual(server.args, ["server.js"]);
  assert.equal(server.env.API_KEY, "secret");
});

test("JSONC parsing removes trailing commas without changing string values", () => {
  const [server] = parseMcpConfig('{"mcpServers":{"fixture":{"command":"node","args":[],"env":{"TOKEN":"keep,}"},},},}', "config.jsonc");
  assert.equal(server.env.TOKEN, "keep,}");
});
