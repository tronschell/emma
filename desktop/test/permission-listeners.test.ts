import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { PermissionAsk } from "../shared/agents";

const source = readFileSync(path.resolve(__dirname, "../../src/agents.tsx"), "utf8");
const start = source.indexOf("let askQueue");
const end = source.indexOf("\n\nexport function usePermissionAsk", start);
assert.ok(start >= 0 && end > start);
const compiled = ts.transpileModule(`${source.slice(start, end)}\nreturn { subscribeAsks, queue: () => askQueue };`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

test("permission listeners wire once and keep asks across subscriber gaps", async () => {
  const asks: ((ask: PermissionAsk) => void)[] = [];
  const resolved: ((value: { id: string; allowed: boolean }) => void)[] = [];
  const ask = (id: string) => ({ id, threadId: "thread", tool: "computer", summary: id, detail: id });
  const window = { emma: {
    onPermissionAsk: (listener: (ask: PermissionAsk) => void) => { asks.push(listener); return () => {}; },
    onPermissionResolved: (listener: (value: { id: string; allowed: boolean }) => void) => { resolved.push(listener); return () => {}; },
    listAsks: () => Promise.resolve([ask("first"), ask("restored")]),
  } };
  const { subscribeAsks, queue } = new Function("window", compiled)(window) as { subscribeAsks: (listener: () => void) => () => void; queue: () => { id: string }[] };

  let notifications = 0;
  const unsubscribe = subscribeAsks(() => { notifications++; });
  asks[0](ask("first"));
  assert.equal(notifications, 1);
  await Promise.resolve();
  assert.deepEqual(queue().map(({ id }) => id), ["first", "restored"]);
  unsubscribe();

  asks[0](ask("between"));
  assert.deepEqual(queue().map(({ id }) => id), ["first", "restored", "between"]);

  const received: string[] = [];
  const again = subscribeAsks(() => { received.push(queue().at(-1)?.id ?? ""); });
  asks[0](ask("second"));
  resolved[0]({ id: "between", allowed: true });
  again();

  assert.deepEqual(received, ["second", "second"]);
  assert.deepEqual(queue().map(({ id }) => id), ["first", "restored", "second"]);
  assert.equal(asks.length, 1);
  assert.equal(resolved.length, 1);
});
