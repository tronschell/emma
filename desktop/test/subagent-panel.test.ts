import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { subagentRows } from "../src/threads";
import type { LiveAgent } from "../shared/agents";
import type { Thread } from "../src/types";

const source = ts.createSourceFile("App.tsx", readFileSync(path.resolve(__dirname, "../../src/App.tsx"), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function initializer(name: string): string {
  let found: string | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer && !found) {
      found = node.initializer.getText(source);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(found, `App.tsx no longer declares ${name}`);
  return found;
}

type Scene = { agents: LiveAgent[]; subagents: unknown[]; tab: string; threadId: string; loadedSubthread: Thread | undefined };

const openAgentCode = initializer("openAgent");
const pastAgentCode = initializer("pastAgent");

function panelFor(scene: Scene): { panel: string; openAgent: unknown; pastAgent: unknown } {
  const keys = ["agents", "subagents", "tab", "threadId", "loadedSubthread"];
  const values = keys.map((key) => (scene as unknown as Record<string, unknown>)[key]);
  const body = ts.transpile(
    `const openAgent = ${openAgentCode}; const pastAgent = ${pastAgentCode}; return { openAgent, pastAgent, panel: openAgent ? "agent" : pastAgent ? "past" : "none" };`,
    { target: ts.ScriptTarget.ES2022 },
  );
  return Function(...keys, body)(...values) as { panel: string; openAgent: unknown; pastAgent: unknown };
}

const thread = (id: string, kind: Thread["kind"], parent?: string): Thread => ({
  id,
  title: id === "main" ? "Ship the notes" : "Ada",
  kind,
  parentThreadId: parent ?? null,
  createdAt: "2026-08-29T19:48:04Z",
  updatedAt: "2026-08-29T19:48:24Z",
  messages: [{ role: "user", content: "Audit the release notes.", timestamp: "2026-08-29T19:48:04Z" }],
});

const live = (threadId: string, parentThreadId: string): LiveAgent => ({
  threadId,
  parentThreadId,
  title: "Milo",
  color: "#4f9dff",
  status: "running",
  mode: "acceptEdits",
  model: "z-ai/glm-5.3-flash",
  activity: "reading src/App.tsx",
  prompt: "Audit the release notes.",
  tool: true,
  startedAt: Date.now() - 20_000,
  steps: 4,
  toolCalls: 3,
  inputTokens: 1200,
  outputTokens: 340,
  generationMs: 9000,
});

const threads = [thread("main", "main"), thread("t1", "subagent", "main")];

test("a finished subagent the live rail forgot opens the recorded panel, not an agent panel of invented numbers", () => {
  const subagents = subagentRows(threads, [], "main");
  assert.deepEqual(subagents.map((row) => row.threadId), ["t1"], "the rail still lists it");

  const chosen = panelFor({ agents: [], subagents, tab: "t1", threadId: "main", loadedSubthread: threads[1] });
  assert.equal(chosen.openAgent, undefined);
  assert.equal(chosen.panel, "past", "PastAgentPanel is the only panel that can honestly draw a row with no run record");
});

test("a recorded subagent row claims no elapsed time, mode, model or token stats", () => {
  const [row] = subagentRows(threads, [], "main");
  for (const key of ["startedAt", "endedAt", "mode", "model", "steps", "toolCalls", "inputTokens", "outputTokens", "generationMs"]) {
    assert.equal((row as unknown as Record<string, unknown>)[key], undefined, `${key} was invented for a run that left no record`);
  }
});

test("a live subagent still opens the agent panel with its own run record", () => {
  const running = live("t2", "main");
  const subagents = subagentRows(threads, [running], "main");
  assert.deepEqual(subagents.map((row) => row.threadId), ["t1", "t2"]);

  const chosen = panelFor({ agents: [running], subagents, tab: "t2", threadId: "main", loadedSubthread: undefined });
  assert.equal(chosen.panel, "agent");
  assert.equal((chosen.openAgent as LiveAgent).startedAt, running.startedAt);
});

test("an agent running under another thread never opens in this thread", () => {
  const elsewhere = live("t9", "other");
  const chosen = panelFor({ agents: [elsewhere], subagents: [], tab: "t9", threadId: "main", loadedSubthread: undefined });
  assert.equal(chosen.openAgent, undefined);
});
