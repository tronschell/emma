import test from "node:test";
import assert from "node:assert/strict";
import { BackgroundCommands } from "../main/background";

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(ready: () => boolean, limitMs = 10_000) {
  const deadline = Date.now() + limitMs;
  while (!ready() && Date.now() < deadline) await settle(20);
  assert.ok(ready(), "the background task never settled");
}

test("a background command returns straight away, keeps printing, and stops on request", async () => {
  const changes: number[] = [];
  const commands = new BackgroundCommands(() => changes.push(Date.now()));
  const started = commands.start(process.cwd(), process.platform === "win32" ? "echo up & ping 127.0.0.1 -n 30 > nul" : "echo up; sleep 30", "test");
  assert.equal(started.status, "running");
  await until(() => /up/.test(commands.output(started.id, 1024)!.output));
  assert.equal(commands.list()[0].status, "running");
  assert.equal(commands.stop(started.id), true);
  await until(() => commands.list()[0].status === "exited");
  assert.equal(commands.list()[0].status, "exited");
  assert.equal(commands.stop(started.id), false);
  assert.equal(commands.output("bg99", 10), undefined);
  assert.ok(changes.length >= 2);
});

test("background shutdown waits through the graceful phase", async () => {
  const commands = new BackgroundCommands(() => undefined);
  const started = commands.start(process.cwd(), process.platform === "win32" ? "ping 127.0.0.1 -n 30 > nul" : "sleep 30", "test");
  await settle(100);
  await commands.stopAll();
  assert.equal(commands.list().find((task) => task.id === started.id)?.status, "exited");
});
