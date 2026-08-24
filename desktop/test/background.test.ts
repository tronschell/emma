import test from "node:test";
import assert from "node:assert/strict";
import { BackgroundCommands } from "../main/background";

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a background command returns straight away, keeps printing, and stops on request", async () => {
  const changes: number[] = [];
  const commands = new BackgroundCommands(() => changes.push(Date.now()));
  const started = commands.start(process.cwd(), "echo up; sleep 30", "test");
  // The point of the whole thing: the call is already back while the command runs.
  assert.equal(started.status, "running");
  await settle(300);
  assert.match(commands.output(started.id, 1024)!.output, /up/);
  assert.equal(commands.list()[0].status, "running");
  assert.equal(commands.stop(started.id), true);
  await settle(300);
  assert.equal(commands.list()[0].status, "exited");
  // Stopping something already stopped is a no, not a throw.
  assert.equal(commands.stop(started.id), false);
  assert.equal(commands.output("bg99", 10), undefined);
  assert.ok(changes.length >= 2);
});
