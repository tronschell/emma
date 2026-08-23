import test from "node:test";
import assert from "node:assert/strict";
import { BackgroundCommands, describeTasks } from "../main/background";
import { describeToolCall, parseToolArgs } from "../main/tools";

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a background command returns straight away, keeps printing, and stops on request", async () => {
  const changes: number[] = [];
  const commands = new BackgroundCommands(() => changes.push(Date.now()));
  const started = commands.start(process.cwd(), "echo up; sleep 30", "test");
  // The point of the whole thing: the call is already back while the command runs.
  assert.equal(started.status, "running");
  await settle(300);
  assert.match(commands.output(started.id, 1024)!.output, /up/);
  assert.match(describeTasks(commands.list()), /running/);
  assert.equal(commands.stop(started.id), true);
  await settle(300);
  assert.equal(commands.list()[0].status, "exited");
  // Stopping something already stopped is a no, not a throw.
  assert.equal(commands.stop(started.id), false);
  assert.equal(commands.output("bg99", 10), undefined);
  assert.ok(changes.length >= 2);
});

test("the background flag and the background tool parse", () => {
  const parse = (name: string, args: unknown) => parseToolArgs(name, JSON.stringify(args));
  assert.equal(parse("bash", { command: "npm run dev" }).name, "bash");
  assert.equal(describeToolCall(parse("bash", { command: "npm run dev", background: true })), "starting npm run dev");
  assert.deepEqual(parse("background", {}), { name: "background", id: undefined, stop: false });
  assert.equal(describeToolCall(parse("background", { id: "bg1", stop: true })), "stopping bg1");
  assert.throws(() => parse("bash", { command: "ls", background: "yes" }), /true or false/);
});
