import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { agentName, AGENT_NAMES, collapseChanges, diffHunks, diffLines, diffStat, sentByThread, spawnedThread, type FileChange } from "../shared/agents";
import { asPermissionMode, toolGate } from "../shared/permissions";
import { browserArgv, describeToolCall, parseToolArgs, shellQuoted, toolDefinitions, MAX_TOOL_OUTPUT_BYTES } from "../main/tools";
import { AgentRuntime, bounded, type LoopDeps } from "../main/agent-loop";
import type { VerifierReview } from "../main/verifier";
import { decodeSpans } from "../shared/trace";

const everything = { folders: true, computer: true };
const noReview: VerifierReview = { model: "", prompt: "", reply: "", attempts: 0, error: "no verifier" };

const runtime = (deps: Partial<LoopDeps> = {}) => new AgentRuntime({
  request: async () => ({}),
  ask: () => {},
  answered: () => undefined,
  verify: async () => noReview,
  advise: async () => ({ model: "", text: "no advisor" }),
  spawnTurn: () => {},
  changed: () => {},
  step: () => {},
  ...deps,
});

test("the gate loosens one rung at a time, and never for a name Emma does not advertise", () => {
  assert.equal(toolGate("ask", "keep"), "auto");
  assert.equal(toolGate("ask", "run_tool"), "ask");
  assert.equal(toolGate("acceptEdits", "run_tool"), "ask");
  assert.equal(toolGate("full", "run_tool"), "auto");
  assert.equal(toolGate("full", "write_file"), "hidden");
  assert.equal(toolGate("full", "rm_rf"), "hidden");
});

test("every tool that gates to ask has a door that asks", () => {
  const asked = toolDefinitions("full", everything)
    .map((tool) => tool.name)
    .filter((name) => toolGate("ask", name) === "ask" || toolGate("acceptEdits", name) === "ask");
  assert.deepEqual(asked.sort(), ["autoresearch", "browser", "cli", "computer", "install_mcp", "run_tool", "secret", "workflow"]);
});

test("a tool is only offered once the thing it drives is actually connected", () => {
  const named = (available: typeof everything) => toolDefinitions("full", available).map((tool) => tool.name);
  assert.ok(!named({ ...everything, folders: false }).includes("cli"));
  assert.ok(named({ ...everything, computer: false }).every((name) => name !== "computer"));
});

test("tool arguments are validated before anything runs", () => {
  const parse = (name: string, args: unknown) => parseToolArgs(name, JSON.stringify(args));
  assert.deepEqual(parse("web_search", { query: "zig comptime" }), { name: "web_search", query: "zig comptime", limit: 8 });
  assert.throws(() => parse("install_mcp", { name: "context7" }), /command/);
  assert.throws(() => parse("run_tool", { name: "tidy", input: "x".repeat(5000) }), /long/);
  assert.throws(() => parse("cli_runs", { id: "cli1", stop: "yes" }), /true or false/);
  assert.throws(() => parse("wipe_disk", {}), /wipe_disk/);
  assert.throws(() => parseToolArgs("run_tool", "not json"), /JSON/);
  assert.equal(describeToolCall(parse("cli_runs", { id: "cli1" })), "reading cli1");
  assert.deepEqual(parse("keep", {}), { name: "keep", kind: "page", title: undefined, text: undefined, url: undefined });
  assert.equal(describeToolCall(parse("keep", {})), "keeping the page in front");
  assert.equal(describeToolCall(parse("keep", { url: "https://example.com/a" })), "keeping https://example.com/a");
  assert.deepEqual(parse("shortcut", { accelerator: "Command+Alt+K", label: "Focus", prompt: "Summarize my work." }), { name: "shortcut", accelerator: "Command+Alt+K", label: "Focus", prompt: "Summarize my work." });
  assert.equal(describeToolCall(parse("shortcut", { accelerator: "Command+Alt+K", label: "Focus", prompt: "Summarize my work." })), "binding Command+Alt+K to Focus");
  assert.equal(toolGate("ask", "shortcut"), "auto");
  assert.ok(toolDefinitions("full", everything).some((tool) => tool.name === "shortcut"));
});

test("a browser call becomes agent-browser's own command line, in its own argument order", () => {
  const argv = (args: Record<string, unknown>) => browserArgv(parseToolArgs("browser", JSON.stringify(args)) as Parameters<typeof browserArgv>[0]);
  assert.deepEqual(argv({ action: "get", field: "attr", selector: "@e1", name: "href" }), ["get", "attr", "@e1", "href"]);
  assert.deepEqual(argv({ action: "scroll" }), ["scroll", "down"]);
  assert.deepEqual(argv({ action: "scroll", direction: "up", amount: 400.7 }), ["scroll", "up", "400"]);
  assert.deepEqual(argv({ action: "snapshot", interactive: true, selector: "main" }), ["snapshot", "-i", "-s", "main"]);
  assert.deepEqual(argv({ action: "type", selector: "@e2", text: "hi" }), ["type", "@e2", "hi"]);
  assert.deepEqual(argv({ action: "type", text: "hi" }), ["keyboard", "type", "hi"]);
  assert.deepEqual(argv({ action: "back" }), ["back"]);

  const parse = (args: unknown) => parseToolArgs("browser", JSON.stringify(args));
  assert.throws(() => parse({ action: "surf" }), /action must be one of/);
  assert.throws(() => parse({ action: "click" }), /selector/);
  assert.throws(() => parse({ action: "open" }), /url/);
  assert.throws(() => parse({ action: "get", field: "attr", selector: "@e1" }), /name/);
  assert.throws(() => parse({ action: "scroll", amount: -80 }), /pixels/);
  assert.equal(describeToolCall(parse({ action: "click", selector: "@e1" })), "clicking @e1");
  assert.equal(describeToolCall(parse({ action: "snapshot" })), "looking at the page");
});

test("a tool Emma wrote herself is listed before it is run, and runs as one shell word", async () => {
  const parse = (name: string, args: unknown) => parseToolArgs(name, JSON.stringify(args));
  assert.deepEqual(parse("run_tool", {}), { name: "run_tool", tool: undefined, input: undefined });
  assert.equal(describeToolCall(parse("run_tool", {})), "listing its own tools");
  assert.equal(describeToolCall(parse("run_tool", { name: "tidy-invoices" })), "running the tool tidy-invoices");
  assert.throws(() => parse("write_tool", { name: "x", code: "#!/bin/sh\necho hi" }), /description/);
  assert.equal(toolGate("acceptEdits", "write_tool"), "auto");
  assert.equal(toolGate("acceptEdits", "run_tool"), "ask");

  const hostile = `'; rm -rf ~; echo '`;
  const { stdout } = await promisify(execFile)("/bin/bash", ["-lc", `echo ${shellQuoted(hostile)}`]);
  assert.equal(stdout, `${hostile}\n`);
});

test("an unknown permission mode falls back rather than throwing", () => {
  assert.equal(asPermissionMode("full"), "full");
  assert.equal(asPermissionMode("root"), "ask");
  assert.equal(asPermissionMode(undefined), "ask");
});

test("a diff marks only the lines that moved", () => {
  const kinds = (before: string, after: string) => diffLines(before, after).map((line) => line.kind).join("");
  assert.equal(kinds("a\nb\nc", "a\nB\nc"), " -+ ");
  assert.ok(!kinds("same\n", "same\n").includes("+"));
  assert.ok(diffLines("", "one\ntwo").every((line) => line.kind === "+"));
});

test("an inline edit shows the changed lines with context, numbered as the file now reads", () => {
  const before = ["one", "two", "three", "four", "five", "six", "seven", "eight"].join("\n");
  const hunks = diffHunks(before, before.replace("five", "FIVE"));
  assert.deepEqual(hunks.map((line) => `${line.line}${line.kind}${line.text}`), ["3 three", "4 four", "5-five", "5+FIVE", "6 six", "7 seven"]);
  assert.ok(!hunks.some((line) => line.text === "one"));
});

test("many writes to one file collapse to a single before-and-after", () => {
  const changes: FileChange[] = [
    { folderId: "f", path: "a.ts", before: "one\n", after: "two\n", at: 1 },
    { folderId: "f", path: "a.ts", before: "two\n", after: "three\n", at: 2 },
    { folderId: "f", path: "b.ts", before: "keep\n", after: "keep\n", at: 3 },
  ];
  const collapsed = collapseChanges(changes);
  assert.deepEqual(collapsed, [{ folderId: "f", path: "a.ts", before: "one\n", after: "three\n", at: 2 }]);
  assert.deepEqual(diffStat(collapsed), { added: 1, removed: 1, files: 1 });
});

test("a turn the harness drives still shows up as a live agent", () => {
  const agents = runtime();
  agents.adopt({ threadId: "t1", content: "build it", mode: "full", title: "Build it", model: "some/model" });
  assert.equal(agents.list().length, 1);
  assert.equal(agents.busy, true);

  agents.noteDelta("t1", "x".repeat(40));
  agents.noteTool("t1", "call-1", "running npm test");
  agents.noteTool("t1", "call-1", "running npm test");
  agents.noteTool("t1", "call-2", "reading a.ts");
  const [live] = agents.list();
  assert.equal(live.toolCalls, 2);
  assert.equal(live.activity, "reading a.ts");
  assert.equal(live.outputTokens, 10);

  agents.finish("t1");
  assert.equal(agents.list()[0].status, "done");
  assert.equal(agents.busy, false);
  assert.ok(agents.list()[0].generationMs > 0, "a finished run always has a duration to divide by");

  agents.adopt({ threadId: "t2", content: "again", mode: "ask", title: "Again" });
  agents.finish("t2", "emma-cli exited with code 1");
  assert.equal(agents.list().find((agent) => agent.threadId === "t2")?.status, "failed");
});

test("a stopped run says stopped, and its abandoned answer stops arriving", () => {
  const agents = runtime();
  agents.adopt({ threadId: "t1", content: "think about it", mode: "full", title: "This thread" });
  agents.adopt({ threadId: "t2", content: "and this", mode: "full", title: "Under it", parentThreadId: "t1", depth: 1 });
  assert.equal(agents.noteDelta("t1", "before"), true);

  agents.stop("t1");
  assert.equal(agents.noteDelta("t1", "after"), false);
  agents.finish("t1");
  assert.equal(agents.list().find((agent) => agent.threadId === "t1")?.status, "stopped");
  agents.finish("t2", "the harness went away");
  assert.equal(agents.list().find((agent) => agent.threadId === "t2")?.status, "stopped");
});

test("a mid-turn message is refused rather than queued where nothing would deliver it", () => {
  const agents = runtime();
  assert.throws(() => agents.steer("t1", "hurry up"), /no longer running/);
  agents.adopt({ threadId: "t1", content: "read the notes", mode: "full", title: "Notes" });
  assert.throws(() => agents.steer("t1", "hurry up"), /could not reach the turn/);
});

test("an agent reads every kind of thread, starts one of its own, and talks to it", async () => {
  const library = {
    threads: [
      { id: "root-1", title: "Trip plans", kind: "main", updatedAt: "2026-01-01T00:00:00Z", messages: [{ role: "user", content: "first", timestamp: "2026-01-01T00:00:00Z" }, { role: "assistant", content: "second", timestamp: "2026-01-01T00:01:00Z" }] },
      { id: "sub-1", title: "Check the flights", kind: "subagent", parentThreadId: "root-1", updatedAt: "2026-01-01T00:02:00Z", messages: [] },
    ],
  };
  const steps = [
    { action: "list" },
    { action: "read", thread: "root-1", limit: 1 },
    { action: "spawn", title: "Book the hotel", prompt: "find somewhere near the centre" },
    { action: "rename", title: "Rome in June" },
    { action: "message", thread: "thread-made-000000000", prompt: "walkable, please" },
  ];
  const created: Record<string, string>[] = [];
  const renamed: Record<string, string>[] = [];
  const spawned: { threadId: string; content: string; mode: string; owner?: string }[] = [];
  const agents = runtime({
    request: async (method, params) => {
      if (method === "snapshot") return library;
      if (method === "createThread") {
        created.push(params);
        library.threads.push({ id: "thread-made-000000000", title: params.title, kind: "main", parentThreadId: params.parentThreadId, updatedAt: "2026-01-01T00:03:00Z", messages: [] });
        return { id: "thread-made-000000000" };
      }
      if (method === "renameThread") { renamed.push(params); return {}; }
      return {};
    },
    spawnTurn: (turn, owner) => { spawned.push({ threadId: turn.threadId, content: turn.content, mode: turn.mode, owner }); },
  });
  const turn = { threadId: "root-1", content: "look around", mode: "full" as const, title: "This thread" };
  agents.adopt(turn);
  const results: string[] = [];
  for (const step of steps) results.push(await agents.runThreadTool(parseToolArgs("threads", JSON.stringify(step)), turn));

  assert.match(results[0], /root-1 · main/);
  assert.match(results[0], /sub-1 · subagent under root-1/);
  assert.match(results[1], /second/);
  assert.doesNotMatch(results[1], /\nfirst/);
  assert.match(results[1], /the 1 oldest not shown/);
  assert.deepEqual(created, [{ parentThreadId: "root-1", title: "Book the hotel" }]);
  assert.deepEqual(spawnedThread(results[2]), { id: "thread-made-000000000", title: "Book the hotel" });
  assert.deepEqual(renamed, [{ threadId: "root-1", title: "Rome in June" }]);
  assert.deepEqual(spawned, [
    { threadId: "thread-made-000000000", content: "[thread root-1 messaged]\nfind somewhere near the centre", mode: "full", owner: "root-1" },
    { threadId: "thread-made-000000000", content: "[thread root-1 messaged]\nwalkable, please", mode: "full", owner: "root-1" },
  ]);
  assert.deepEqual(sentByThread(spawned[1].content), { from: "root-1", body: "walkable, please" });
  assert.deepEqual(sentByThread("walkable, please"), { body: "walkable, please" });
});

test("an adopted run times the model from the tokens coming back", () => {
  const recorded: string[] = [];
  const agents = runtime({ request: async (method, params) => { if (method === "recordTrace") recorded.push(params.trace); return {}; } });
  agents.adopt({ threadId: "t1", content: "build it", mode: "full", title: "Build it" });
  agents.noteDelta("t1", "thinking");
  agents.noteDelta("t1", " more");
  const open = () => agents.spans().t1.filter((span) => span.kind === "model");
  assert.equal(open().length, 1, "one stretch of talking is one span, not one per token");
  agents.noteTool("t1", "call-1", "running npm test", { threadId: "t1", toolCallId: "call-1", title: "npm test", kind: "execute", status: "in_progress", at: Date.now() });
  assert.equal(open()[0].endedAt !== undefined, true, "the work starting is the model stopping");
  agents.finish("t1");
  assert.equal(agents.spans().t1, undefined, "a traced turn is the thread's record, not a live one");
  const stored = decodeSpans(recorded.at(-1) ?? "");
  assert.ok(stored.length > 0, "the finished turn recorded no trace at all");
  assert.ok(stored.every((span) => span.endedAt !== undefined), "a finished turn leaves nothing open");
  assert.equal(stored.find((span) => span.kind === "agent")?.status, "ok");
});

test("a steer is kept in the turn's trace at the point the answer had reached", () => {
  const recorded: string[] = [];
  const agents = runtime({ request: async (method, params) => { if (method === "recordTrace") recorded.push(params.trace); return {}; } });
  agents.adopt({ threadId: "t1", content: "build it", mode: "full", title: "Build it" });
  agents.noteDelta("t1", "Reading the styles.");
  agents.noteSteer("t1", "stop, use the other palette");
  const live = agents.spans().t1.find((span) => span.kind === "steer");
  assert.equal(live?.input, "stop, use the other palette");
  assert.equal(live?.said, "Reading the styles.".length);
  agents.finish("t1");
  const stored = decodeSpans(recorded.at(-1) ?? "").find((span) => span.kind === "steer");
  assert.equal(stored?.input, "stop, use the other palette", "the steer did not survive into the stored trace");
  assert.equal(stored?.parentId, "agent:t1");
});

test("a truncated tool result still fits the host's byte ceiling", () => {
  const output = bounded("é".repeat(MAX_TOOL_OUTPUT_BYTES));
  assert.ok(Buffer.byteLength(output) <= MAX_TOOL_OUTPUT_BYTES);
  assert.ok(output.endsWith("[truncated]"));
  assert.equal(bounded("short"), "short");
});

test("the harness reaches the thread and agent tools without a loop of its own", async () => {
  const library = {
    threads: [
      { id: "root-1", title: "Trip plans", kind: "main", updatedAt: "2026-01-01T00:00:00Z", messages: [{ role: "user", content: "first", timestamp: "2026-01-01T00:00:00Z" }] },
      { id: "sub-1", title: "Check the flights", kind: "main", parentThreadId: "root-1", updatedAt: "2026-01-01T00:02:00Z", messages: [] },
    ],
  };
  const created: Record<string, string>[] = [];
  const agents = runtime({
    request: async (method, params) => {
      if (method === "snapshot") return library;
      if (method === "createThread") { created.push(params); return { id: "thread-made-000000000" }; }
      if (method === "readTrace") return [];
      return {};
    },
  });
  const turn = { threadId: "root-1", content: "look around", mode: "full" as const, title: "This thread" };
  const call = (name: string, raw: string) => agents.runThreadTool(parseToolArgs(name, raw), turn);

  const listed = await call("threads", JSON.stringify({ action: "list" }));
  assert.match(listed, /root-1 · main/);
  assert.match(listed, /sub-1 · main under root-1/);
  assert.match(await call("threads", JSON.stringify({ action: "read", thread: "root-1" })), /first/);
  assert.match(await call("read_trace", "{}"), /no recorded traces/);
  await call("threads", JSON.stringify({ action: "spawn", title: "Book the hotel" }));
  assert.equal(created[0].parentThreadId, "root-1");
  assert.match(await call("agents", "{}"), /Nothing is running/);

  agents.adopt(turn);
  const live = await call("agents", "{}");
  assert.match(live, /root-1 · running/);
  assert.match(live, /This thread/);
  await assert.rejects(() => call("agents", JSON.stringify({ agent: "root-1", message: "use the cheaper flight" })), /could not reach the turn/);
  agents.adopt({ threadId: "sub-1", content: "check the flights", mode: "full", title: "Check the flights" });
  await assert.rejects(() => call("threads", JSON.stringify({ action: "message", thread: "sub-1", prompt: "hurry" })), /could not reach the turn/);
  await assert.rejects(() => call("threads", JSON.stringify({ action: "message", thread: "root-1", prompt: "hurry" })), /the thread you are in/);
  assert.match(await call("agents", JSON.stringify({ agent: "root-1", stop: true })), /Stopped root-1/);

  await assert.rejects(() => call("web_search", JSON.stringify({ query: "x" })), /not one of Emma's thread tools/);
});

test("steering and stopping need a named agent", async () => {
  assert.throws(() => parseToolArgs("agents", JSON.stringify({ message: "hi" })), /Say which agent/);
  assert.throws(() => parseToolArgs("agents", JSON.stringify({ stop: true })), /Say which agent/);
  assert.throws(() => parseToolArgs("agents", JSON.stringify({ agent: "a", message: "hi", stop: true })), /not both/);
});

test("switching the picker mid-run re-points the run and everything under it", () => {
  const agents = runtime();
  agents.adopt({ threadId: "t1", content: "write two files", mode: "ask", title: "Write" });
  agents.adopt({ threadId: "t2", content: "step one", mode: "ask", title: "Step one", parentThreadId: "t1", depth: 1 });
  agents.setMode("t1", "full");
  assert.deepEqual(agents.list().map((agent) => agent.mode), ["full", "full"]);
});


test("a subagent is named off its id, the same way every time, and never twice at once", () => {
  const first = agentName("child-1");
  assert.equal(agentName("child-1"), first);
  assert.ok(AGENT_NAMES.includes(first as (typeof AGENT_NAMES)[number]));
  assert.notEqual(agentName("child-1", new Set([first])), first);
  const live = new Set<string>();
  for (let i = 0; i < 8; i += 1) live.add(agentName(`child-${i}`, live));
  assert.equal(live.size, 8);
});
