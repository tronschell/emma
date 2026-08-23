import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ImportedCapabilityRuntime, listEmmaTools, MAX_SKILL_RESULTS, parseMcpConfig, seedBuiltinSkills, SkillAttachmentStore, writeEmmaTool } from "../main/capabilities";
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
    // What the skills page, the schedule form, the tool-target list and mention
    // resolution all ask for. Below this the four of them throw rather than
    // return a short list, and every one of those failures is swallowed.
    assert.ok(await runtime.searchSkills("", MAX_SKILL_RESULTS));
    assert.match((await runtime.selectSkill(found.id)).instructions, /Rebuild, then verify\./);
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

test("an imported stdio server is listed with its arguments redacted and its environment values withheld", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "emma-mcp-"));
  try {
    const userData = path.join(root, "user-data");
    const config = path.join(root, "claude.json");
    await mkdir(userData, { recursive: true });
    await writeFile(config, JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: ["-e", "process.exit(0)"], env: { MCP_SECRET: "do-not-render" } } } }));
    await writeFile(path.join(userData, "imports.json"), JSON.stringify({ version: 1, sources: [{ id: "claude", skillRoots: [], mcpFiles: [config] }] }));

    const servers = await new ImportedCapabilityRuntime(userData).listMcpServers();
    assert.equal(servers.length, 1);
    assert.equal(servers[0].command, process.execPath);
    assert.deepEqual(servers[0].args, ["-e", "[argument 2 redacted]"]);
    assert.deepEqual(servers[0].environmentKeys, ["MCP_SECRET"]);
    assert.equal(JSON.stringify(servers).includes("do-not-render"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an installed MCP server is listed with no import and no relaunch", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "emma-install-mcp-"));
  const userData = path.join(root, "user-data");
  const runtime = new ImportedCapabilityRuntime(userData);
  try {
    const definition = { name: "fixture", command: process.execPath, args: ["-e", "process.exit(0)"], env: { WHO: "installed" } };

    assert.deepEqual(await runtime.installMcpServer(definition), { id: "mcp:emma:0:fixture" });

    const listed = await new ImportedCapabilityRuntime(userData).listMcpServers();
    assert.deepEqual(listed.map((server) => server.id), ["mcp:emma:0:fixture"]);
    assert.deepEqual(listed[0].environmentKeys, ["WHO"]);
    assert.equal(JSON.stringify(listed).includes("installed"), false);

    await runtime.installMcpServer(definition);
    assert.equal((await runtime.listMcpServers()).length, 1);
    await assert.rejects(() => runtime.installMcpServer({ ...definition, name: "not a name" }), /not valid/);
  } finally {
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
