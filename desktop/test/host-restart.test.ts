import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";

type FakeChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { write: (line: string, done: (error?: Error) => void) => void; destroyed: boolean; on: () => void; end: () => void };
  killed: boolean;
  kill: () => void;
  written: string[];
};

function hostClass(spawned: FakeChild[], callMs: number) {
  const source = readFileSync(path.join(__dirname, "../main/main.js"), "utf8");
  const classSource = source.match(/class Host \{[\s\S]*?\n\}\n/)?.[0];
  assert.ok(classSource, "Host class source");
  const spawn = () => {
    const child = new EventEmitter() as FakeChild;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.written = [];
    child.killed = false;
    child.kill = () => { child.killed = true; };
    child.stdin = {
      destroyed: false,
      on: () => undefined,
      end: () => undefined,
      write: (line, done) => { child.written.push(line); done(); },
    };
    spawned.push(child);
    return child;
  };
  return runInNewContext(`${classSource}\nHost`, {
    node_child_process_1: { spawn },
    process: { env: {} },
    console,
    setTimeout,
    clearTimeout,
    Date,
    MAX_HOST_RESPONSE_BYTES: 1024 * 1024,
    MAX_HOST_CALL_MS: callMs,
    SNAPSHOT_CACHE_MS: 5000,
    runScheduledWorkflow: async () => undefined,
    ndjson_1: {
      parseHostLine: (line: string) => JSON.parse(line),
      BoundedLines: class {
        push(data: Buffer) { return String(data).split("\n").filter(Boolean); }
        end() { return undefined; }
      },
      HostResponses: class {
        push(frame: unknown) { return frame; }
        end() { return undefined; }
        clear() { return undefined; }
      },
    },
  }) as new (binary: string) => { request: (r: { method: string; params: Record<string, string> }) => Promise<unknown>; close: () => void };
}

test("a host that never answers is killed, and the next call gets a fresh one", async () => {
  const spawned: FakeChild[] = [];
  const host = new (hostClass(spawned, 30))("emma-host");

  await assert.rejects(host.request({ method: "createThread", params: {} }), /stopped answering/);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].killed, true);

  const answered = host.request({ method: "createThread", params: {} });
  assert.equal(spawned.length, 2, "a failed host is replaced rather than latched");
  const id = String(JSON.parse(spawned[1].written[0]).id);
  spawned[1].stdout.emit("data", Buffer.from(`${JSON.stringify({ id, ok: true, result: { threadId: "t1" } })}\n`));
  assert.deepEqual(await answered, { threadId: "t1" });
});

test("a host closed on purpose stays closed", async () => {
  const spawned: FakeChild[] = [];
  const host = new (hostClass(spawned, 30))("emma-host");
  host.close();

  await assert.rejects(host.request({ method: "thread", params: {} }), /closed/);
  assert.equal(spawned.length, 1);
});
