import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { collapseChanges, diffLines, diffStat, sentByThread, spawnedThread, type FileChange } from "../shared/agents";
import { asPermissionMode, toolGate } from "../shared/permissions";
import { browserArgv, describeToolCall, parseToolArgs, shellQuoted, toolDefinitions, MAX_TOOL_OUTPUT_BYTES } from "../main/tools";
import { AgentRuntime, bounded, type LoopDeps } from "../main/agent-loop";
import type { VerifierReview } from "../main/verifier";
import { decodeSpans } from "../shared/trace";

const everything = { folders: true, computer: true };
/** No verifier configured, which is what every mode but `auto` gets anyway. */
const noReview: VerifierReview = { model: "", prompt: "", reply: "", attempts: 0, error: "no verifier" };

/** A runtime wired to nothing, so each test names only the dep it is about. */
const runtime = (deps: Partial<LoopDeps> = {}) => new AgentRuntime({
  request: async () => ({}),
  ask: () => {},
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
  // Emma's tools are registered with the harness as needing no approval on the
  // grounds that `runEmmaTool` asks instead — which it only does for what is
  // listed here. A new tool at `ask` fails this until someone says so.
  assert.deepEqual(asked.sort(), ["autoresearch", "browser", "cli", "computer", "install_mcp", "run_tool", "workflow"]);
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
  // "Add this page to my kb" carries no URL: the tool goes and finds the page itself.
  assert.deepEqual(parse("keep", {}), { name: "keep", kind: "page", title: undefined, text: undefined, url: undefined });
  assert.equal(describeToolCall(parse("keep", {})), "keeping the page in front");
  assert.equal(describeToolCall(parse("keep", { url: "https://example.com/a" })), "keeping https://example.com/a");
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
  // No name is the listing call, which is how the model finds out what it wrote
  // in some earlier thread.
  assert.deepEqual(parse("run_tool", {}), { name: "run_tool", tool: undefined, input: undefined });
  assert.equal(describeToolCall(parse("run_tool", {})), "listing its own tools");
  assert.equal(describeToolCall(parse("run_tool", { name: "tidy-invoices" })), "running the tool tidy-invoices");
  assert.throws(() => parse("write_tool", { name: "x", code: "#!/bin/sh\necho hi" }), /description/);
  // Writing is not running, so it goes through where `write_skill` does; running
  // one is arbitrary code, so it stops to ask.
  assert.equal(toolGate("acceptEdits", "write_tool"), "auto");
  assert.equal(toolGate("acceptEdits", "run_tool"), "ask");

  // The input reaches the script as exactly one argument, whatever is in it.
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
  // A new file is all additions, with nothing removed.
  assert.ok(diffLines("", "one\ntwo").every((line) => line.kind === "+"));
});

test("many writes to one file collapse to a single before-and-after", () => {
  const changes: FileChange[] = [
    { folderId: "f", path: "a.ts", before: "one\n", after: "two\n", at: 1 },
    { folderId: "f", path: "a.ts", before: "two\n", after: "three\n", at: 2 },
    { folderId: "f", path: "b.ts", before: "keep\n", after: "keep\n", at: 3 },
  ];
  const collapsed = collapseChanges(changes);
  // b.ts round-tripped back to its original text, so it is not a change at all.
  assert.deepEqual(collapsed, [{ folderId: "f", path: "a.ts", before: "one\n", after: "three\n", at: 2 }]);
  assert.deepEqual(diffStat(collapsed), { added: 1, removed: 1, files: 1 });
});

test("a turn the harness drives still shows up as a live agent", () => {
  // The harness owns the loop, so without adopt() there is no Run at all: the
  // rail is empty and the deltas, tool calls and rate all land nowhere.
  const agents = runtime();
  agents.adopt({ threadId: "t1", content: "build it", mode: "full", title: "Build it", model: "some/model" });
  assert.equal(agents.list().length, 1);
  assert.equal(agents.busy, true);

  agents.noteDelta("t1", "x".repeat(40));
  agents.noteTool("t1", "call-1", "running npm test");
  // The same call reporting completion is the same call, not a second one.
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
  // Text from the cancelled prompt keeps arriving for as long as the model keeps
  // talking; none of it is this thread's answer any more.
  assert.equal(agents.noteDelta("t1", "after"), false);
  // A cancelled prompt comes back through the ordinary path, so the rail would
  // otherwise call a stopped run "done" — or "failed" with the cancellation as
  // its error, which reads as a crash.
  agents.finish("t1");
  assert.equal(agents.list().find((agent) => agent.threadId === "t1")?.status, "stopped");
  // Children die with their parent: nothing is left driving a thread nobody reads.
  agents.finish("t2", "the harness went away");
  assert.equal(agents.list().find((agent) => agent.threadId === "t2")?.status, "stopped");
});

test("a mid-turn message is refused rather than queued where nothing would deliver it", () => {
  const agents = runtime();
  assert.throws(() => agents.steer("t1", "hurry up"), /no longer running/);
  agents.adopt({ threadId: "t1", content: "read the notes", mode: "full", title: "Notes" });
  // The harness's top-level session holds a second prompt until the first ends
  // rather than folding it in, and this loop no longer drains a queue of its own
  // — so a message taken here would never be delivered at all.
  assert.throws(() => agents.steer("t1", "hurry up"), /takes nothing mid-turn/);
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
  const results: string[] = [];
  for (const step of steps) results.push(await agents.runThreadTool(parseToolArgs("threads", JSON.stringify(step)), turn));

  // The index carries both kinds: a subagent's transcript is a thread too, and
  // the whole point of the tool is that a subagent can go and read one.
  assert.match(results[0], /root-1 · main/);
  assert.match(results[0], /sub-1 · subagent under root-1/);
  // A limit reads the end of a thread, which is where the answer is.
  assert.match(results[1], /second/);
  assert.doesNotMatch(results[1], /\nfirst/);
  assert.match(results[1], /the 1 oldest not shown/);
  // A sub thread is owned by the thread that started it and is nobody's subagent.
  assert.deepEqual(created, [{ parentThreadId: "root-1", title: "Book the hotel" }]);
  // The transcript draws its card off the first line alone, so what the loop
  // wrote and what the renderer reads back are checked against each other here.
  assert.deepEqual(spawnedThread(results[2]), { id: "thread-made-000000000", title: "Book the hotel" });
  // Renaming reaches the thread the turn is in, not a new one.
  assert.deepEqual(renamed, [{ threadId: "root-1", title: "Rome in June" }]);
  // A spawn with a prompt puts an agent to work through the same door every other
  // surface uses — so it runs on the coding harness when Emma is on the harness —
  // under this turn's mode, and in the project of the thread that started it.
  // Messaging a thread with nothing running starts a turn of its own the same way.
  // Both carry the thread that sent them at the head of the message: the sender
  // is not otherwise recoverable from a stored turn, which is why the transcript
  // used to sign another agent's words "You".
  assert.deepEqual(spawned, [
    { threadId: "thread-made-000000000", content: "[thread root-1 messaged]\nfind somewhere near the centre", mode: "full", owner: "root-1" },
    { threadId: "thread-made-000000000", content: "[thread root-1 messaged]\nwalkable, please", mode: "full", owner: undefined },
  ]);
  // What the loop wrote and what the transcript reads back, checked against each
  // other the same way the spawn card above is.
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
  // The turn is on the thread now, so it is no longer reported as live: drawn
  // from both, the timeline showed the turn that just ended twice and counted
  // its minutes twice in the total.
  assert.equal(agents.spans().t1, undefined, "a traced turn is the thread's record, not a live one");
  const stored = decodeSpans(recorded.at(-1) ?? "");
  assert.ok(stored.length > 0, "the finished turn recorded no trace at all");
  // An open span in a stored trace is measured against the clock every time it
  // is drawn, so the turn kept growing after it had ended.
  assert.ok(stored.every((span) => span.endedAt !== undefined), "a finished turn leaves nothing open");
  // The turn's own span says how the turn ended. The sweep above used to close
  // it before `closeRun` could, so every stored turn read as permanently
  // running and carried no error when one had failed. A call the harness never
  // reported the end of is left as it was — "running" with a close on it is
  // exactly "we never heard back".
  assert.equal(stored.find((span) => span.kind === "agent")?.status, "ok");
});

test("a truncated tool result still fits the host's byte ceiling", () => {
  const output = bounded("é".repeat(MAX_TOOL_OUTPUT_BYTES));
  assert.ok(Buffer.byteLength(output) <= MAX_TOOL_OUTPUT_BYTES);
  assert.ok(output.endsWith("[truncated]"));
  assert.equal(bounded("short"), "short");
});

test("the harness reaches the thread and agent tools without a loop of its own", async () => {
  // The harness runs its own loop, so its turns never pass through `runTool`.
  // Everything Emma knows about its threads and its live agents reaches it
  // through this one entry point instead; without it the MCP bridge advertised
  // these tools and then fell off the end of main's executor switch.
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
  // A sub thread names the thread that owns it, which is the link the sidebar draws.
  assert.match(listed, /sub-1 · main under root-1/);
  assert.match(await call("threads", JSON.stringify({ action: "read", thread: "root-1" })), /first/);
  assert.match(await call("read_trace", "{}"), /no recorded traces/);
  await call("threads", JSON.stringify({ action: "spawn", title: "Book the hotel" }));
  assert.equal(created[0].parentThreadId, "root-1");
  // A spawn without a prompt is a place to work, not work: nothing was started.
  assert.match(await call("agents", "{}"), /Nothing is running/);

  // A harness turn is adopted, so it shows up in the agent list like any other run.
  agents.adopt(turn);
  const live = await call("agents", "{}");
  assert.match(live, /root-1 · running/);
  assert.match(live, /This thread/);
  // But the loop is the harness's, and its top-level session takes nothing
  // mid-turn: a message accepted here would never be delivered, so it is refused
  // rather than swallowed. The harness steers its own subagents, over its own
  // protocol.
  await assert.rejects(() => call("agents", JSON.stringify({ agent: "root-1", message: "use the cheaper flight" })), /takes nothing mid-turn/);
  // `threads message` goes the same way, and refuses this turn's own thread
  // before either: an agent talking to itself is an answer, not a message.
  agents.adopt({ threadId: "sub-1", content: "check the flights", mode: "full", title: "Check the flights" });
  await assert.rejects(() => call("threads", JSON.stringify({ action: "message", thread: "sub-1", prompt: "hurry" })), /takes nothing mid-turn/);
  await assert.rejects(() => call("threads", JSON.stringify({ action: "message", thread: "root-1", prompt: "hurry" })), /the thread you are in/);
  assert.match(await call("agents", JSON.stringify({ agent: "root-1", stop: true })), /Stopped root-1/);

  // A tool main's executor owns is not silently answered here.
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
  // The harness gates the calls, but it is told the mode per prompt — so the rail
  // has to carry the mode the run is actually on, not the one it started under.
  agents.setMode("t1", "full");
  assert.deepEqual(agents.list().map((agent) => agent.mode), ["full", "full"]);
});

