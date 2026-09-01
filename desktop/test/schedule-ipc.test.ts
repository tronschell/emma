import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { validateRequest } from "../main/ipc";
import type { TurnRequest } from "../main/agent-loop";
import { asPermissionMode } from "../shared/permissions";
import { CODEX_PREFIX, codexSlug, providerChatUrl, routerChain, routerIdFor } from "../shared/settings";
import { packVariables, parseVariables, parseWorkflow, runWorkflow } from "../shared/workflow";

const source = ts.createSourceFile("App.tsx", readFileSync(path.join(__dirname, "../../src/App.tsx"), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const editor = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "TaskEditor");
assert.ok(editor?.body);
const save = editor.body.statements.flatMap((node) => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : []).find((node) => node.name.getText(source) === "save");
assert.ok(save?.initializer);
const code = ts.transpile(`return (${save.initializer.getText(source)});`, { target: ts.ScriptTarget.ES2022 });

test("scheduled create and edit payloads from TaskEditor preserve the selected or inherited model", async () => {
  for (const job of [undefined, { id: "job-123456789012", sourceDomains: ["example.com"] }]) {
    for (const model of ["", "openrouter:deepseek/deepseek-chat", "provider:local"]) {
      for (const nodes of ["", "[]"]) {
        const calls: unknown[] = [];
        const saved: string[] = [];
        const scope = {
          ready: true, busy: false, job, title: " Weekly ", trigger: " manual ", prompt: " Find reading ", nodes, mode: "ask", model,
          act: async (method: string, params: Record<string, string>) => {
            const request = { method, params };
            assert.deepEqual(validateRequest(request), request);
            calls.push(request);
            return { id: job?.id ?? "job-987654321012" };
          },
          onSaved: (id: string) => saved.push(id),
        };
        await Function(...Object.keys(scope), code)(...Object.values(scope))();
        assert.deepEqual(calls, [{ method: "saveScheduledJob", params: {
          ...(job ? { jobId: job.id } : {}), title: "Weekly", schedule: "manual", prompt: "Find reading",
          ...(nodes ? { nodes } : {}), sourceDomains: JSON.stringify(job?.sourceDomains ?? []), permissionMode: "ask", model,
        } }]);
        assert.deepEqual(saved, [job?.id ?? "job-987654321012"]);
      }
    }
  }
});

test("scheduled model support preserves IPC field and size restrictions", () => {
  const params = { title: "Weekly", schedule: "manual", prompt: "Find reading", sourceDomains: "[]", permissionMode: "ask" };
  assert.deepEqual(validateRequest({ method: "saveScheduledJob", params }).params, params);
  for (const model of [undefined, null, false, 1, [], {}, "x".repeat(65_537)]) {
    assert.throws(() => validateRequest({ method: "saveScheduledJob", params: { ...params, model } }), /Invalid parameters/);
  }
  for (const key of [...Object.keys(params), "jobId", "nodes"]) {
    for (const value of ["", "   "]) {
      assert.throws(() => validateRequest({ method: "saveScheduledJob", params: { ...params, model: "", [key]: value } }), /Invalid parameters/);
    }
  }
  assert.throws(() => validateRequest({ method: "saveScheduledJob", params: { ...params, model: "", extra: "x" } }), /Invalid parameters/);
  assert.throws(() => validateRequest({ method: "saveScheduledJob", params: { ...params, model: "😀".repeat(32_768) } }), /Request is too large/);
  for (const model of ["", "provider:local"]) {
    assert.throws(() => validateRequest({ method: "sendMessage", params: { threadId: "thread-123456789", content: "hello", model } }), /Invalid parameters/);
  }
  assert.throws(() => validateRequest({ method: "selectOpenRouterModel", params: { modelId: "" } }), /Invalid parameters/);
});

test("scheduled workflows use Emma's selected model unless the job pins a model", async () => {
  const main = ts.createSourceFile("main.ts", readFileSync(path.join(__dirname, "../../main/main.ts"), "utf8"), ts.ScriptTarget.Latest, true);
  const names = ["runScheduledWorkflow", "providerFor", "providerRoute", "harnessModel"];
  const functions = names.map((name) => {
    const declaration = main.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(declaration);
    return declaration.getText(main);
  }).join("\n");
  const keys = ["", "provider:local", "openrouter:vendor/model", "router:chosen"];
  for (const selectedModel of keys) {
    for (const model of keys) {
      const turns: TurnRequest[] = [];
      const requests: unknown[] = [];
      const scope = {
        selectedModel, threadModel: () => "",
        providers: [{ id: "local", modelId: "local-model", baseUrl: "http://127.0.0.1:1234/v1", credentialEnv: "" }],
        routers: [{ id: "chosen", models: ["vendor/model", "vendor/other"] }],
        modelCatalog: { ids: () => ["vendor/model", "vendor/other"] },
        process: { env: {} }, providerChatUrl, routerChain, routerIdFor, CODEX_PREFIX, codexSlug,
        asPermissionMode, packVariables, parseVariables, parseWorkflow, runWorkflow,
        resolveMentions: async (prompt: string) => prompt,
        driveTurn: async (turn: TurnRequest) => { turns.push(turn); },
        lastAssistantMessage: () => "done",
        host: { request: async (request: unknown) => { requests.push(request); } },
        changed: () => {},
      };
      const runtime = Function(...Object.keys(scope), ts.transpile(`${functions}\nreturn { runScheduledWorkflow, providerRoute, harnessModel };`, { target: ts.ScriptTarget.ES2022 }))(...Object.values(scope));
      await runtime.runScheduledWorkflow({ jobId: "job", threadId: "fresh-thread", title: "Scheduled task", prompt: "hello", nodes: "", variables: "", permissionMode: "ask", model, depth: 0 });
      const expected = model || selectedModel;
      assert.equal(turns.length, 1);
      assert.equal(turns[0].model, expected);
      assert.equal(runtime.harnessModel(turns[0].model), {
        "": undefined, "provider:local": "local-model", "openrouter:vendor/model": "vendor/model", "router:chosen": "vendor/model,vendor/other",
      }[expected]);
      assert.deepEqual(runtime.providerRoute(turns[0].model), expected === "provider:local"
        ? { id: "local", chatUrl: "http://127.0.0.1:1234/v1/chat/completions", apiKey: "no-key" }
        : undefined);
      assert.deepEqual(requests, [{ method: "finishScheduledJob", params: { jobId: "job", outputs: '{"last":"done"}', depth: "0" } }]);
    }
  }
});
