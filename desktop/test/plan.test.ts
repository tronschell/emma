import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MAX_PLAN_REVISIONS, PLAN_PAD, PLAN_ROW, mergePlan, parsePlan, parsePlanSteps, planLayout, planProblems, planProgress, planRows, planState, readySteps, renderPlan, stepBrief, type Plan } from "../shared/plan";
import { deletePlan, editPlan, listPlans, readPlan, savePlan } from "../main/plans";
import { parseToolArgs } from "../main/tools";

const plan = (steps: Plan["steps"]): Plan => ({ id: "ship-it", title: "Ship it", goal: "Get the thing out.", steps, updatedAt: "" });
const step = (id: string, needs: string[] = [], extra: Partial<Plan["steps"][number]> = {}): Plan["steps"][number] =>
  ({ id, title: `Do ${id}`, status: "todo", needs, brief: `Work on ${id}.`, tasks: [], ...extra });

test("the markdown file is the plan, and reading it back gives the plan again", () => {
  const before = plan([
    step("step-1", [], { status: "done", tasks: [{ text: "read the code", done: true }, { text: "write it down", done: false }], result: "Found the parser." }),
    step("step-2", ["step-1"], { status: "running" }),
  ]);
  const markdown = renderPlan(before);
  assert.deepEqual(parsePlan("ship-it", markdown), before);
  // And again, so a rewrite of an already-rendered file is stable.
  assert.equal(renderPlan(parsePlan("ship-it", markdown)), markdown);
});

test("the plan remembers which thread's inspector it belongs in", () => {
  const owned = { ...plan([step("step-1")]), threadId: "thread-7", goal: "Get the thing out." };
  const markdown = renderPlan(owned);
  assert.ok(markdown.includes("thread: thread-7"));
  const parsed = parsePlan("ship-it", markdown);
  assert.equal(parsed.threadId, "thread-7");
  assert.equal(parsed.goal, "Get the thing out.", "the thread line is not swallowed into the goal");
  assert.equal(parsePlan("ship-it", "# Ship it\n\nJust a goal.\n").threadId, undefined);
  // A subagent rewriting its own plan must not move it into a sub thread nobody
  // is looking at, so the thread that wrote it keeps it.
  assert.equal(mergePlan(owned, { ...owned, threadId: "sub-thread" }).threadId, "thread-7");
});

test("a hand-mangled file loses structure, never everything", () => {
  const parsed = parsePlan("notes", "# Half a plan\n\nsome goal\n\n## step-1 · First `wat`\nneeds: nobody, step-1\n- [x] did it\n- [ ]\nfree prose\n\n## STEP TWO\n");
  assert.equal(parsed.title, "Half a plan");
  assert.equal(parsed.goal, "some goal");
  assert.equal(parsed.steps.length, 1);
  assert.equal(parsed.steps[0].status, "todo", "an unreadable status falls back rather than throwing");
  assert.deepEqual(parsed.steps[0].needs, [], "a step cannot wait on itself or on something absent");
  assert.deepEqual(parsed.steps[0].tasks, [{ text: "did it", done: true }]);
  // A heading that is not `## <id> · <title>` is not a step — it stays as the prose
  // it looks like rather than becoming a subagent nobody wrote a brief for.
  assert.equal(parsed.steps[0].brief, "free prose\n\n## STEP TWO");
});

test("a row of the graph is one wave, and the wave is what runs at once", () => {
  const steps = [step("a"), step("b"), step("c", ["a", "b"]), step("d", ["a"])];
  assert.deepEqual(planRows(steps), [["a", "b"], ["c", "d"]]);
  assert.deepEqual(readySteps(plan(steps)).map((item) => item.id), ["a", "b"]);
  // c waits on both, so finishing only a does not release it.
  const half = [step("a", [], { status: "done" }), step("b"), step("c", ["a", "b"]), step("d", ["a"])];
  assert.deepEqual(readySteps(plan(half)).map((item) => item.id), ["b", "d"]);
});

test("the drawn graph puts a wave on a row, and folds one too wide to fit", () => {
  const { spots, height } = planLayout([["a", "b", "c"], ["d"]]);
  assert.deepEqual([...spots.keys()], ["a", "b", "c", "d"]);
  assert.deepEqual([spots.get("a")!.x, spots.get("b")!.x, spots.get("c")!.x], [25, 50, 75], "evenly spaced, none on the edge");
  assert.equal(spots.get("d")!.y - spots.get("a")!.y, PLAN_ROW, "the next wave is one row down");
  assert.equal(spots.get("d")!.wave, 1);
  assert.equal(height, PLAN_PAD * 2 + PLAN_ROW);

  // Eight abreast would leave 8px between nodes in this column, so a wide wave
  // takes two lines — still one wave, still one row apart from the next.
  const wide = planLayout([Array.from({ length: 8 }, (_, i) => `s${i}`), ["last"]]);
  assert.equal(wide.spots.get("s5")!.y + PLAN_ROW, wide.spots.get("s6")!.y);
  assert.equal(wide.spots.get("s6")!.wave, 0, "the fold is a line, not a new wave");
  assert.equal(wide.spots.get("last")!.y, wide.spots.get("s6")!.y + PLAN_ROW);
  assert.equal(planLayout([]).height, 0, "no steps, no canvas");

  const roomy = planLayout([["a", "b"], ["c"]], [], 56);
  assert.equal(roomy.spots.get("c")!.y - roomy.spots.get("a")!.y, 56, "the fullscreen map spaces its rows out");
  assert.equal(roomy.height, PLAN_PAD * 2 + 56);
});

test("a tree draws as a tree: a step sits over the branch it fans out into", () => {
  const steps = [step("root"), step("p2", ["root"]), step("c4", ["p2"]), step("p1", ["root"]), step("c1", ["p1"]), step("c2", ["p1"]), step("c3", ["p1"])];
  const { spots } = planLayout(planRows(steps), steps);
  const x = (id: string) => spots.get(id)!.x;
  const mid = (...ids: string[]) => ids.reduce((total, id) => total + x(id), 0) / ids.length;
  assert.deepEqual([x("c4"), x("c1"), x("c2"), x("c3")], [20, 40, 60, 80], "a row is ordered by where each step's parent sits, so a branch stays together");
  assert.equal(x("p1"), mid("c1", "c2", "c3"), "over the middle of its three children");
  assert.equal(x("p2"), mid("c4"), "over its only one");
  assert.equal(x("root"), mid("p1", "p2"), "over the middle of the two branches");

  const web = [step("a"), step("b"), step("c"), step("join", ["b", "c"])];
  const spread = planLayout(planRows(web), web).spots;
  assert.deepEqual([spread.get("a")!.x, spread.get("b")!.x, spread.get("c")!.x], [25, 50, 75], "the parents of a shared step keep their own places rather than piling onto it");
});

test("a cycle is named, not left as steps that quietly never run", () => {
  const rows = planRows([step("a", ["b"]), step("b", ["a"])]);
  assert.deepEqual(rows.flat().sort(), ["a", "b"], "stranded steps still land on the canvas");
  const problems = planProblems(plan([step("a", ["b"]), step("b", ["a"])]));
  assert.ok(problems.some((problem) => problem.includes("wait on each other")), problems.join("; "));
  assert.deepEqual(planProblems(plan([])), ["This plan has no steps."]);
  const chain = planProblems(plan([step("a"), step("b", ["a"]), step("c", ["b"])]));
  assert.ok(chain.some((problem) => problem.includes("runs at once")), chain.join("; "));
  assert.deepEqual(planProblems(plan([step("a"), step("b"), step("c", ["a", "b"])])), [], "a plan that fans out anywhere is worth writing");
  assert.ok(planProblems(plan([step("a", [], { brief: "", tasks: [] })]))[0].includes("says nothing"));
});

test("rewriting a plan mid-run keeps what it has already lived through", () => {
  const before = plan([
    step("step-1", [], { status: "done", tasks: [{ text: "read the code", done: true }], result: "Found the parser." }),
    step("step-2", ["step-1"], { status: "failed" }),
  ]);
  const rewritten = plan([
    step("step-1", [], { tasks: [{ text: "read the code", done: false }, { text: "and the tests", done: false }] }),
    step("step-2", ["step-1"], { status: "todo" }),
    step("step-3", ["step-2"]),
  ]);
  const merged = mergePlan(before, rewritten);
  assert.equal(merged.steps[0].status, "done", "a finished step is not re-run because the plan was restructured");
  assert.equal(merged.steps[0].result, "Found the parser.");
  assert.deepEqual(merged.steps[0].tasks.map((task) => task.done), [true, false], "ticks survive by text, new tasks start unticked");
  assert.equal(merged.steps[1].status, "failed");
  assert.equal(merged.steps[2].status, "todo");
  // A status the rewrite states outright still wins over the old one.
  assert.equal(mergePlan(before, plan([step("step-2", [], { status: "done" })])).steps[0].status, "done");
});

test("progress counts steps and boxes separately", () => {
  const progress = planProgress(plan([
    step("a", [], { status: "done", tasks: [{ text: "one", done: true }, { text: "two", done: true }] }),
    step("b", ["a"], { tasks: [{ text: "three", done: false }] }),
  ]));
  assert.deepEqual(progress, { done: 1, steps: 2, tasks: 3, doneTasks: 2 });
});

test("a plan says where it got to, so the row of them says which one is live", () => {
  assert.equal(planState(plan([])), "todo");
  assert.equal(planState(plan([step("a"), step("b", ["a"])])), "todo");
  assert.equal(planState(plan([step("a", [], { status: "done" }), step("b", ["a"], { status: "running" })])), "running");
  assert.equal(planState(plan([step("a", [], { status: "failed" }), step("b", ["a"])])), "failed");
  assert.equal(planState(plan([step("a", [], { status: "failed" }), step("b", [], { status: "running" })])), "running", "a wave still going outranks a step that fell over in the one before it");
  assert.equal(planState(plan([step("a", [], { status: "done" }), step("b", ["a"], { status: "done" })])), "done");
});

test("a plan write that cannot be run is refused with every reason at once", () => {
  assert.deepEqual(parsePlanSteps("nope").errors, ["steps is not valid JSON. Send a JSON array of steps, as a string."]);
  assert.deepEqual(parsePlanSteps("[]").errors, ["A plan needs at least one step."]);
  const { errors } = parsePlanSteps(JSON.stringify([
    { id: "Step One", title: "shouty" },
    { id: "one", title: "", brief: "" },
    { id: "one", title: "again", brief: "twice" },
    { id: "two", title: "waits", brief: "on air", needs: ["nowhere"] },
    { id: "three", title: "loops", brief: "on itself", needs: ["three"] },
  ]));
  assert.ok(errors.some((error) => error.includes("lowercase letters, digits and dashes")), errors.join("; "));
  assert.ok(errors.some((error) => error.includes("needs a title")), errors.join("; "));
  assert.ok(errors.some((error) => error.includes("needs a brief or tasks")), errors.join("; "));
  assert.ok(errors.some((error) => error.includes('repeats the id "one"')), errors.join("; "));
  assert.ok(errors.some((error) => error.includes('waits on "nowhere"')), errors.join("; "));
  assert.ok(errors.some((error) => error.includes("waits on itself")), errors.join("; "));
});

test("tasks are accepted as plain strings or as boxes with ticks", () => {
  const { steps, errors } = parsePlanSteps(JSON.stringify([
    { id: "s1", title: "Read", tasks: ["read the code", { text: "and the tests", done: true }, { text: "" }, 7] },
  ]));
  assert.deepEqual(errors, []);
  assert.deepEqual(steps[0].tasks, [{ text: "read the code", done: false }, { text: "and the tests", done: true }]);
});

test("the subagent is told everything it cannot see for itself", () => {
  const brief = stepBrief(plan([
    step("step-1", [], { status: "done", result: "The parser is in shared/plan.ts." }),
    step("step-2", ["step-1"], { tasks: [{ text: "write the view", done: false }] }),
  ]), step("step-2", ["step-1"], { tasks: [{ text: "write the view", done: false }] }));
  assert.ok(brief.includes("Get the thing out."), "the goal");
  assert.ok(brief.includes("The parser is in shared/plan.ts."), "what the earlier wave found");
  assert.ok(brief.includes("write the view"), "its own tasks");
  assert.ok(brief.includes('"action":"update"'), "how to tick a box");

  const after = stepBrief(plan([
    step("step-1", [], { status: "failed", result: "The endpoint 404s — it moved to /v2." }),
    step("step-2", [], { tasks: [] }),
  ]), step("step-2", [], { tasks: [] }));
  assert.ok(after.includes("The endpoint 404s — it moved to /v2."), "and what a failed step already walked into");
});

test("the tool refuses a call it could only half-do", () => {
  const call = (args: Record<string, unknown>) => parseToolArgs("plan", JSON.stringify(args)) as Record<string, unknown>;
  assert.equal(call({ action: "read" }).action, "read", "reading takes no id — it lists the plans");
  assert.throws(() => call({ action: "run" }), /id/);
  assert.throws(() => call({ action: "write", title: "Ship it" }), /steps/);
  assert.throws(() => call({ action: "update", id: "ship-it" }), /step/);
  assert.throws(() => call({ action: "update", id: "ship-it", step: "step-1" }), /status|result|check/);
  assert.throws(() => call({ action: "sing", id: "ship-it" }), /action/);
  assert.equal(call({ action: "update", id: "ship-it", step: "step-1", check: 2 }).check, 2);
});

test("a whole wave ticking the same file at once loses nothing", async () => {
  const root = path.join(tmpdir(), `emma-plans-${randomUUID()}`);
  try {
    const plan = await savePlan(root, {
      title: "Ship the planner", goal: "Get it out.",
      steps: [
        step("step-1", [], { tasks: [{ text: "a", done: false }, { text: "b", done: false }] }),
        step("step-2", ["step-1"]),
      ],
    });
    assert.equal(plan.id, "ship-the-planner", "the file is named after the plan");
    const twin = await savePlan(root, { title: "Ship the planner", goal: "", steps: [step("s")] });
    assert.notEqual(twin.id, plan.id, "a second plan of the same name gets its own file");

    // What a wave actually does: several subagents editing one file with awaits in
    // between. Without the queue in plans.ts these are lost updates.
    const tick = (id: string, at: number) => editPlan(root, plan.id, (current) => ({
      ...current,
      steps: current.steps.map((item) => item.id === id ? { ...item, tasks: item.tasks.map((task, index) => index === at ? { ...task, done: true } : task) } : item),
    }));
    await Promise.all([
      tick("step-1", 0),
      tick("step-1", 1),
      editPlan(root, plan.id, (current) => ({ ...current, steps: current.steps.map((item) => item.id === "step-2" ? { ...item, status: "done" as const, result: "did it" } : item) })),
    ]);
    const after = await readPlan(root, plan.id);
    assert.deepEqual(after.steps[0].tasks.map((task) => task.done), [true, true]);
    assert.equal(after.steps[1].status, "done");
    assert.equal(after.steps[1].result, "did it");

    await assert.rejects(() => readPlan(root, "../../etc/passwd"), /not a plan id/, "an id is checked before any I/O");
    await deletePlan(root, twin.id);
    assert.deepEqual((await listPlans(root)).map((item) => item.id), [plan.id]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a rewrite records what it changed, and the file is where that is kept", () => {
  const before = plan([step("survey"), step("port", ["survey"]), step("drop")]);
  const after = mergePlan(before, plan([
    step("survey", [], { brief: "Read every caller, twice." }),
    step("port", ["survey"]),
    step("verify", ["port"]),
  ]), "2026-08-24T09:00:00Z");
  assert.deepEqual(after.revisions, [{ at: "2026-08-24T09:00:00Z", steps: 3, added: ["verify"], removed: ["drop"], rewritten: ["survey"] }]);
  assert.deepEqual(parsePlan("ship-it", renderPlan(after)).revisions, after.revisions);
  assert.equal(renderPlan(parsePlan("ship-it", renderPlan(after))), renderPlan(after));
  // A plan that was never rewritten carries no revisions at all, so the round
  // trip of an untouched plan is still the plan.
  assert.equal(parsePlan("ship-it", renderPlan(before)).revisions, undefined);
});

test("the revisions kept are the recent ones, and the oldest fall off", () => {
  let current = plan([step("survey")]);
  for (let index = 0; index < MAX_PLAN_REVISIONS + 5; index += 1) {
    current = mergePlan(current, plan([step("survey", [], { title: `Do survey ${index}` })]), `2026-08-24T09:${String(index).padStart(2, "0")}:00Z`);
  }
  assert.equal(current.revisions?.length, MAX_PLAN_REVISIONS);
  assert.equal(current.revisions?.at(-1)?.at, "2026-08-24T09:36:00Z");
  assert.equal(current.revisions?.[0].at, "2026-08-24T09:05:00Z");
});

test("a hand-mangled revisions section loses lines, never the plan", () => {
  const parsed = parsePlan("notes", [
    "# Half a plan",
    "",
    "some goal",
    "",
    "## step-1 · First `todo`",
    "needs: —",
    "",
    "the brief survives",
    "",
    "## Revisions",
    "",
    "- 2026-08-24T09:00:00Z · 2 steps · added: port · removed: · rewritten: NOT AN ID",
    "- who knows",
    "",
    "- · steps",
    "- 2026-08-24T10:00:00Z · 900 steps",
  ].join("\n"));
  assert.equal(parsed.steps.length, 1);
  assert.equal(parsed.steps[0].brief, "the brief survives", "the revisions heading does not eat the brief");
  assert.deepEqual(parsed.revisions, [
    { at: "2026-08-24T09:00:00Z", steps: 2, added: ["port"], removed: [], rewritten: [] },
    { at: "2026-08-24T10:00:00Z", steps: 24, added: [], removed: [], rewritten: [] },
  ]);
});
