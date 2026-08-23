import test from "node:test";
import assert from "node:assert/strict";
import { buildTrigger, describeTrigger, evaluate, expand, MAX_VARIABLES_BYTES, MAX_WORKFLOW_STEPS, packVariables, parseTrigger, parseVariables, parseWorkflow, runWorkflow, triggerProblem, workflowEdges, workflowRows } from "../shared/workflow";

test("a job saved before workflows existed is one agent step on its prompt", () => {
  const { nodes, errors } = parseWorkflow("", "Find useful reading");
  assert.deepEqual(errors, []);
  assert.deepEqual(nodes, [{ id: "step-1", kind: "agent", text: "Find useful reading" }]);
});

test("a broken graph is refused with the reason, not silently half-run", () => {
  assert.deepEqual(parseWorkflow("not json").errors, ["The graph is not valid JSON."]);
  const { errors } = parseWorkflow(JSON.stringify([
    { id: "one", kind: "agent", text: "do it", next: "nowhere" },
    { id: "one", kind: "agent", text: "again" },
    { id: "two", kind: "branch", text: "x" },
    { id: "three", kind: "if", text: "{{x}}" },
    { id: "four", kind: "set", text: "5" },
  ]));
  assert.ok(errors.some((error) => error.includes('points its next at "nowhere"')), errors.join("; "));
  assert.ok(errors.some((error) => error.includes('repeats the id "one"')), errors.join("; "));
  assert.ok(errors.some((error) => error.includes("kind of agent, set or if")), errors.join("; "));
  assert.ok(errors.some((error) => error.includes("condition Emma cannot read")), errors.join("; "));
  assert.ok(errors.some((error) => error.includes("no variable to save it in")), errors.join("; "));
});

test("conditions read the way they are written, and refuse what they cannot read", () => {
  const variables = { digest: "Two papers on sleep", count: "3", empty: "" };
  assert.equal(evaluate("{{digest}} contains SLEEP", variables), true);
  assert.equal(evaluate("{{digest}} does not contain coffee", variables), true);
  assert.equal(evaluate("{{count}} > 2", variables), true);
  assert.equal(evaluate("{{count}} > 30", variables), false);
  assert.equal(evaluate("{{empty}} is empty", variables), true);
  assert.equal(evaluate("{{digest}} is not empty", variables), true);
  assert.equal(evaluate("{{missing}} is not empty", variables), false);
  assert.equal(evaluate("{{digest}} is Two papers on sleep", variables), true);
  // Nonsense is false rather than a guess, and an unset variable expands to nothing.
  assert.equal(evaluate("{{digest}} rhymes with sheep", variables), false);
  assert.equal(expand("read {{missing}} now", variables), "read  now");
});

test("a run branches, carries variables between steps, and stops at the step ceiling", async () => {
  const nodes = parseWorkflow(JSON.stringify([
    { id: "collect", kind: "agent", text: "Collect this week's papers", saveAs: "digest" },
    { id: "check", kind: "if", text: "{{digest}} contains sleep", next: "mail", otherwise: "note" },
    { id: "mail", kind: "agent", text: "Write up {{digest}}", saveAs: "writeup", next: "end" },
    { id: "note", kind: "set", text: "nothing on sleep", saveAs: "writeup" },
  ])).nodes;
  const prompts: string[] = [];
  const run = await runWorkflow(nodes, { seed: "x" }, async (prompt) => {
    prompts.push(prompt);
    return "Three papers on sleep";
  });
  assert.deepEqual(prompts, ["Collect this week's papers", "Write up Three papers on sleep"]);
  assert.equal(run.variables.writeup, "Three papers on sleep");
  assert.equal(run.variables.seed, "x");
  assert.equal(run.variables.last, "Three papers on sleep");
  assert.deepEqual(run.steps.map((step) => step.nodeId), ["collect", "check", "mail"]);

  // A branch pointing backwards is a loop; it runs out of steps instead of forever.
  const loop = parseWorkflow(JSON.stringify([
    { id: "again", kind: "set", text: "{{n}}x", saveAs: "n", next: "again" },
  ])).nodes;
  const spun = await runWorkflow(loop, {}, async () => "");
  assert.equal(spun.steps.length, MAX_WORKFLOW_STEPS);
});

test("stored variables survive a round trip and anything else is ignored", () => {
  assert.deepEqual(parseVariables('{"digest":"two items","count":3}'), { digest: "two items" });
  assert.deepEqual(parseVariables("nonsense"), {});
  assert.deepEqual(parseVariables(""), {});
});

test("a run that produced too much keeps every variable and loses the tails", () => {
  const packed = packVariables({ flag: "yes", huge: "x".repeat(MAX_VARIABLES_BYTES * 2) });
  assert.ok(packed.length <= MAX_VARIABLES_BYTES);
  const read = parseVariables(packed);
  assert.equal(read.flag, "yes");
  assert.ok(read.huge.length > 1000);
});

/* The trigger picker: every preset is a cron line, and reading one back has to
   land on the preset that wrote it or editing a saved task rewrites its trigger. */

test("every preset round-trips through cron", () => {
  const cases = [
    ["*/15 * * * *", "minutes"],
    ["30 */6 * * *", "hourly"],
    ["0 9 * * *", "daily"],
    ["0 9 */3 * *", "daily"],
    ["0 9 * * 1,3,5", "weekly"],
    ["0 9 15 * *", "monthly"],
    ["30 8 1 3 *", "yearly"],
    ["manual", "manual"],
  ] as const;
  for (const [cron, kind] of cases) {
    const trigger = parseTrigger(cron);
    assert.equal(trigger.kind, kind, cron);
    assert.equal(buildTrigger(trigger), cron, cron);
    assert.equal(triggerProblem(cron), null, cron);
  }
});

test("a hand-written trigger stays hand-written, and Sunday is always 0", () => {
  assert.equal(parseTrigger("0 9 1-5 * *").kind, "cron");
  assert.equal(buildTrigger(parseTrigger("0 9 1-5 * *")), "0 9 1-5 * *");
  assert.deepEqual(parseTrigger("0 9 * * 7").weekdays, [0]);
  // A weekly trigger with no day picked would never fire, so it means every day.
  assert.equal(buildTrigger({ ...parseTrigger("0 9 * * 1"), weekdays: [] }), "0 9 * * *");
});

test("triggers read back in words", () => {
  assert.equal(describeTrigger("0 9 * * 1,3"), "Mon, Wed at 09:00 UTC");
  assert.equal(describeTrigger("*/5 * * * *"), "Every 5 minutes");
  assert.equal(describeTrigger("0 9 */2 * *"), "Every 2 days at 09:00 UTC");
  assert.equal(describeTrigger("manual"), "Only when you run it");
});

test("the drawn edges are the jumps the runner would take", () => {
  const { nodes } = parseWorkflow(JSON.stringify([
    { id: "collect", kind: "agent", text: "find", saveAs: "digest" },
    { id: "check", kind: "if", text: "{{digest}} is not empty", next: "write", otherwise: "end" },
    { id: "write", kind: "agent", text: "write it up" },
  ]));
  const edges = workflowEdges(nodes);
  assert.deepEqual(edges, [
    { from: "collect", to: "check" },
    { from: "check", to: "write", label: "yes" },
    { from: "check", to: "end", label: "no" },
    { from: "write", to: "end" },
  ]);
  // One row per level, and a step nothing reaches still gets drawn.
  assert.deepEqual(workflowRows(nodes, edges), [["collect"], ["check"], ["write"]]);
  const orphaned = parseWorkflow(JSON.stringify([
    { id: "one", kind: "agent", text: "a", next: "end" },
    { id: "stray", kind: "agent", text: "b" },
  ])).nodes;
  assert.deepEqual(workflowRows(orphaned, workflowEdges(orphaned)), [["one"], ["stray"]]);
});
