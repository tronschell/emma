import test from "node:test";
import assert from "node:assert/strict";
import { BackgroundCommands } from "../main/background";

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "background command did not reach the expected state within 10 seconds");
    await settle(25);
  }
}

test("a background command returns straight away, keeps printing, and stops on request", async (t) => {
  const changes: number[] = [];
  const commands = new BackgroundCommands(() => changes.push(Date.now()));
  t.after(() => commands.stopAll());
  const started = commands.start(process.cwd(), process.platform === "win32" ? "echo up & ping 127.0.0.1 -n 30 > nul" : "echo up; sleep 30", "test");
  assert.equal(started.status, "running");
  await waitFor(() => commands.output(started.id, 1024)!.output.includes("up"));
  assert.match(commands.output(started.id, 1024)!.output, /up/);
  assert.equal(commands.list()[0].status, "running");
  assert.equal(commands.stop(started.id), true);
  await waitFor(() => commands.list()[0].status === "exited");
  assert.equal(commands.list()[0].status, "exited");
  assert.equal(commands.stop(started.id), false);
  assert.equal(commands.output("bg99", 10), undefined);
  assert.ok(changes.length >= 2);
});

test("background shutdown waits through the graceful phase", async (t) => {
  const commands = new BackgroundCommands(() => undefined);
  t.after(() => commands.stopAll());
  const started = commands.start(process.cwd(), process.platform === "win32" ? "ping 127.0.0.1 -n 30 > nul" : "sleep 30", "test");
  await settle(100);
  await commands.stopAll();
  assert.equal(commands.list().find((task) => task.id === started.id)?.status, "exited");
});
