import test from "node:test";
import assert from "node:assert/strict";
import { encodeSpans, traceHeader, type TraceSpan } from "../shared/trace";
import { additionValid, applied, attemptIds, compare, draftProposal, frictionOf, heldBack, lessonBlock, lessonShaped, readTurn, retryDraft, room, spendOf, startTrial, toolOf, unfixable, validateImprovements, MAX_IMPROVEMENTS, MAX_KEPT, MAX_RESULT_CHARS, MIN_ARM_TURNS, type Improvement, type Lever, type Spend, type Turn } from "../shared/improvement";

const span = (over: Partial<TraceSpan>): TraceSpan => ({ id: `s-${over.name ?? "x"}-${over.startedAt ?? 0}`, name: "step", kind: "bash", startedAt: 1, endedAt: 2, status: "ok", ...over });
const thread = { id: "thread-1", title: "Ship it" };
const turn = (arm: "a" | "b", failures: number): Turn =>
  readTurn({ timestamp: "2026-08-20T00:00:00Z", text: encodeSpans([span({ kind: "agent", name: "run" }), ...Array.from({ length: failures }, (_, i) => span({ startedAt: i, status: "failed", output: "boom" }))], { thread: thread.id, arm }) }, thread);

test("a turn is read back off its own trace, arm and all", () => {
  const text = encodeSpans([
    span({ kind: "agent", name: "run", status: "failed" }),
    span({ kind: "bash", status: "failed", output: "zsh: command not found: rg" }),
    span({ kind: "verifier", status: "failed", input: "Proposed action: bash\nCommand: rm -rf /tmp/x", output: '{"allow": false, "reason": "deletes outside the project"}' }),
  ], { thread: thread.id, model: "local", arm: "b" });
  assert.equal(traceHeader(text).arm, "b", "the header is a header, not a span: decodeSpans skips it, traceHeader reads it");
  assert.deepEqual(traceHeader('{"id":"s1","name":"x","startedAt":1}'), {});
  assert.deepEqual(traceHeader("not json"), {});

  const read = readTurn({ timestamp: "2026-08-20T00:00:00Z", text }, thread);
  assert.equal(read.arm, "b");
  assert.equal(read.failures, 1);
  assert.equal(read.blocks, 1);
  assert.equal(read.steps, 1, "a verifier review is not a step the agent took");
  assert.equal(read.ok, false);

  const [tool, verifier] = frictionOf([read, { ...read, at: 2 }]).sort((left, right) => left.kind.localeCompare(right.kind));
  assert.equal(tool.tool, "bash");
  assert.match(tool.evidence[0].text, /command not found/);
  assert.equal(tool.evidence[0].threadId, thread.id);
  assert.equal(verifier.tool, "bash", "the blocked call is named in the verifier's own prompt");
  assert.equal(verifier.evidence[0].text, "deletes outside the project");
  assert.equal(frictionOf([read]).length, 0, "once is not a pattern");
});

test("a trial waits for both arms, then only calls a gap that beats the noise", () => {
  const trial: Improvement = { id: "i1", title: "t", lever: "instructions", addition: "x", metric: "failures", startedAt: 0, look: 1, state: "trial" };
  const thin = compare([turn("a", 3), turn("b", 0)], trial);
  assert.equal(thin.clear, false);
  assert.match(thin.waiting, new RegExp(`${MIN_ARM_TURNS - 1} more`));

  const arm = (side: "a" | "b", counts: number[]) => counts.map((count) => turn(side, count));
  const noisy = compare([...arm("a", [0, 6, 0, 6, 0, 6]), ...arm("b", [6, 0, 6, 0, 6, 0])], trial);
  assert.equal(noisy.waiting, "");
  assert.equal(noisy.clear, false, "same mean, wide spread — nothing to read");

  const unanimous = compare([...arm("a", [3, 3, 3, 3, 3, 3]), ...arm("b", [1, 1, 1, 1, 1, 1])], trial);
  assert.equal(unanimous.clear, true, "every turn moved by the same amount — no spread is the strongest signal, not the weakest");

  const real = compare([...arm("a", [3, 3, 4, 3, 3, 4]), ...arm("b", [0, 0, 1, 0, 0, 1])], trial);
  assert.equal(real.clear, true);
  assert.ok((real.delta ?? 0) < -70);

  assert.equal(compare([...arm("a", [1, 1, 1, 1, 1, 1]), ...arm("b", [0, 0, 0, 0, 0, 0])], { ...trial, startedAt: Date.now() }).a.n, 0, "turns from before the trial started are not its samples");
});

test("only kept improvements ride a turn, and a junk store is no improvements", () => {
  const store = validateImprovements({
    items: [
      { id: "a", title: "Kept", lever: "instructions", addition: "Prefer rg over grep.", metric: "failures", startedAt: 1, state: "kept" },
      { id: "b", title: "Gone", lever: "instructions", addition: "Never do this.", metric: "failures", startedAt: 1, state: "reverted" },
      { id: "c", title: "Trying", lever: "verifier", addition: "Clear reads under the project root.", metric: "blocks", startedAt: 2, state: "trial" },
      { id: "", addition: "no id" },
      { addition: "", id: "d" },
      { id: "e", addition: "Its own parent.", origin: "e", startedAt: 3 },
    ],
  });
  assert.equal(store.items.length, 4);
  assert.equal(store.items[3].origin, undefined, "a row that cites itself as its own first attempt is a family of one");
  const use = applied(store);
  assert.match(use.kept.instructions, /Prefer rg over grep\./);
  assert.doesNotMatch(use.kept.instructions, /Never do this/);
  assert.equal(use.kept.verifier, "", "a trial is not kept text — it rides only arm b");
  assert.deepEqual(use.trial, [{ lever: "verifier", addition: "Clear reads under the project root." }, { lever: "instructions", addition: "Its own parent." }], "every lever on trial rides arm b together");
  assert.equal(lessonBlock([" ", ""]), "");
  assert.deepEqual(validateImprovements("nonsense"), { items: [] });

  const retried = validateImprovements({
    items: [
      { id: "a", title: "Kept", lever: "instructions", addition: "Prefer rg over grep.", metric: "failures", startedAt: 1, state: "kept" },
      { id: "a2", title: "Kept, again", lever: "instructions", addition: "Prefer rg over grep, and say why.", metric: "failures", startedAt: 4, state: "trial", origin: "a" },
    ],
  });
  assert.equal(applied(retried).kept.instructions, "", "a change back under trial rides arm b only, so its kept text stays out of arm a");
});

test("a decided record survives the second look, and the second look knows it is one", () => {
  const draft = { title: "Prefer rg", lever: "instructions" as const, metric: "failures" as const, addition: " Prefer rg over grep. ", look: 1 };
  const first = startTrial([], draft, 1);
  assert.equal(first.length, 1);
  assert.equal(first[0].addition, "Prefer rg over grep.");
  const kept: Improvement[] = first.map((row) => ({ ...row, state: "kept" as const, decidedAt: 2, result: "Kept at 6 paired cases · failed tool calls per turn · -50% · improved · p=0.031" }));

  const again = startTrial(kept, retryDraft(kept[0]), 3);
  assert.equal(again.length, 2, "the second look is a new row beside the old one, not in place of it");
  assert.deepEqual(again[0], kept[0], "a decided record is permanent: its state, its result line and its decidedAt are untouched by a re-proposal");
  assert.equal(applied({ items: again }).kept.instructions, "", "the kept text of the change under trial does not also ride arm a");
  assert.equal(again[1].state, "trial");
  assert.equal(again[1].startedAt, 3, "the arms restart, so only turns after the new start count");
  assert.deepEqual(attemptIds(again, again[1].id), [kept[0].id, again[1].id], "both looks are one family, oldest first, so the record can name them");
  assert.deepEqual(attemptIds(again, kept[0].id), attemptIds(again, again[1].id), "the family reads the same from either end");

  const reworded = startTrial(kept, { ...retryDraft(kept[0]), addition: "bash failed in 6 turns, most recently with “gone”. Use rg." }, 4);
  assert.deepEqual(attemptIds(reworded, reworded[1].id), [kept[0].id, reworded[1].id], "the draft rewrites its own words from live friction and Emma rewords them again — identity is the lineage carried on the record, not the text");

  const other = startTrial(kept, { ...draft, addition: "Prefer fd over find." }, 5);
  assert.equal(other[1].origin, undefined, "another change under the same lever and metric is not a second look at this one");
  assert.deepEqual(attemptIds(other, other[1].id), [other[1].id], "a different change is a family of one");
  const metric = startTrial(kept, { ...draft, metric: "steps" }, 6);
  assert.equal(metric[1].origin, undefined, "the same words read under another metric is another change");

  const pasted = startTrial(kept, draft, 7);
  assert.equal(pasted[1].origin, undefined, "identity is the button the user pressed: a proposal declares a new change, and no text match makes it a second look at an old one");
  assert.equal(pasted[1].look, 1);
  assert.equal(again[1].look, 2, "the look is stamped from the row that was retried, not counted off a store that evicts");
  assert.equal(startTrial(again.map((row) => ({ ...row, state: "reverted" as const })), retryDraft(again[1]), 10).at(-1)?.look, 3);
  assert.equal(validateImprovements({ items: [{ ...again[1], look: undefined }] }).items[0].look, 2, "a stored second look with no number is still not a first look");
  assert.equal(validateImprovements({ items: [{ ...kept[0], look: 9 }] }).items[0].look, 1, "and a lineage root cannot claim to be a later one");

  assert.deepEqual(startTrial(kept, { ...draft, addition: "   " }, 8), kept, "an empty change starts nothing");
  assert.deepEqual(startTrial(again, draft, 9), again, "one trial per lever: a running trial is never replaced by another under its own lever");
  assert.equal(startTrial(again, { ...draft, lever: "advertise", addition: "memory, plan" }, 9).length, 3, "another lever joins the bundle rather than waiting for this one");
  assert.deepEqual(attemptIds(kept, ""), [], "a run with no improvement has no family");
  assert.deepEqual(attemptIds([], "imp-gone"), ["imp-gone"], "a run whose row aged out of the store is still its own attempt");
});

const kept = (id: string, over: Partial<Improvement> = {}): Improvement =>
  ({ id, title: id, lever: "instructions", addition: `Lesson ${id}.`, metric: "failures", startedAt: 1, look: 1, state: "kept", ...over });

test("a store at its ceiling gives up a settled record, never one still being cited", () => {
  const lesson = kept("r0", { addition: "Never rm -rf without asking." });
  const root = kept("r1", { state: "reverted" });
  const child = kept("r2", { origin: "r1", addition: "Ask before rm -rf, and say why." });
  const settled = Array.from({ length: MAX_IMPROVEMENTS - 3 }, (_, index) => kept(`s${index}`, { state: "reverted" }));
  const full = [lesson, root, child, ...settled];
  assert.equal(full.length, MAX_IMPROVEMENTS);
  assert.equal(room(full), settled.length, "room is the settled records nothing is still citing, and only those");

  const draft = { title: "Prefer rg", lever: "instructions" as const, metric: "failures" as const, addition: "Prefer rg over grep.", look: 1 };
  const next = validateImprovements({ items: startTrial(full, draft, 99) }).items;
  assert.equal(next.length, MAX_IMPROVEMENTS);
  assert.equal(next.at(-1)?.state, "trial", "the trial started");
  assert.ok(next.some((item) => item.id === "r0"), "a kept record is the evidence behind text that rides every turn");
  assert.ok(next.some((item) => item.id === "r1"), "a reverted row is still the first attempt of a change that was kept");
  assert.equal(next.find((item) => item.id === "s0"), undefined, "the oldest settled record nothing cites is what makes the room");
  assert.match(applied({ items: next }).kept.instructions, /Never rm -rf without asking\./, "the lesson is still applied on the turn after the write");

  const evidence = Array.from({ length: MAX_IMPROVEMENTS }, (_, index) => kept(`k${index}`));
  assert.equal(room(evidence), 0);
  assert.deepEqual(startTrial(evidence, draft, 100), evidence, "with nothing to spare the store refuses the trial rather than deleting evidence");
  assert.equal(validateImprovements({ items: [...evidence, kept("k40")] }).items.length, MAX_IMPROVEMENTS + 1, "and a store already over the ceiling keeps every record it cannot spare");
});

test("a record's result line is never cut through a number", () => {
  const long = "Stopped on Aug 25 · was Kept at 12 paired cases · verifier blocks per turn · -18% · improved · attempt 8 of 8 · cases 12, 12, 12, 12, 12, 12, 12, 12 · case set changed · earlier attempts dropped · p<0.001";
  assert.ok(long.length > 200);
  assert.equal(validateImprovements({ items: [kept("a", { state: "reverted", result: long })] }).items[0].result, long, "the p value at the tail of a rewrapped record is the p value that was measured");

  const huge = `Kept at 12 paired cases · ${"cases 12, 12, 12, 12, 12, 12, 12 · ".repeat(40)}p=0.031`;
  const stored = validateImprovements({ items: [kept("b", { result: huge })] }).items[0].result ?? "";
  assert.ok(stored.length <= MAX_RESULT_CHARS);
  assert.ok(huge.startsWith(stored), "what is stored is a prefix of what was written");
  assert.equal(huge[stored.length], " ", "and it ends on a boundary, so no number is left reading as a different number");
});

test("a kept lesson that has stopped riding is named, not silently dropped", () => {
  const retried = [kept("a"), kept("a2", { state: "trial", origin: "a", startedAt: 4 })];
  assert.equal(applied({ items: retried }).kept.instructions, "");
  assert.deepEqual(heldBack(retried), ["a"], "a change under a second look rides neither arm, and the page can say which one");

  const many = Array.from({ length: MAX_KEPT + 1 }, (_, index) => kept(`k${index}`));
  assert.deepEqual(heldBack(many), [`k${MAX_KEPT}`], "the lesson past the ceiling is not applied either, so it is named too");
  assert.equal(applied({ items: many }).kept.instructions.split("\n").length, MAX_KEPT + 1);
  assert.deepEqual(heldBack(many.slice(0, MAX_KEPT)), [], "under the ceiling every kept lesson rides");
});

test("a failed call is named by what it said, and a refusal is not a lesson", () => {
  const denied = span({ kind: "execute", name: "Using terminal", status: "failed", input: '{"action":"exec","command":"ls"}', output: '{"error":{"type":"tool_permission_denied","tool_name":"terminal","reason":"user_denied"}}' });
  const shaped = span({ kind: "search", name: "Searching", startedAt: 3, status: "failed", output: 'grep_files requires string field "pattern"' });
  const exited = span({ kind: "execute", name: "Using terminal", startedAt: 4, status: "failed", input: '{"action":"exec","command":"grep x y"}', output: "That failed: command exited with non-zero status 1" });

  assert.equal(toolOf(denied), "terminal", "the tool name in the error beats the span's category");
  assert.equal(toolOf(shaped), "grep_files");
  assert.equal(toolOf(exited), "terminal", "an exec call with no name in its output is still the terminal");
  assert.equal(unfixable(denied), true);
  assert.equal(unfixable(exited), true);
  assert.equal(unfixable(shaped), false);

  const text = encodeSpans([span({ kind: "agent", name: "run" }), denied, shaped, exited], { thread: thread.id });
  const read = readTurn({ timestamp: "2026-08-20T00:00:00Z", text }, thread);
  const found = frictionOf([read, { ...read, at: 2 }]);
  const terminal = found.find((item) => item.tool === "terminal");
  const grep = found.find((item) => item.tool === "grep_files");
  assert.equal(terminal?.hits, 4, "both execute calls group under the one recovered name");
  assert.equal(lessonShaped(terminal!), false, "nothing you could write removes a refusal or a non-zero exit");
  assert.equal(lessonShaped(grep!), true);
});

test("a turn preserves its model identity and infers missing family metadata", () => {
  const text = encodeSpans([span({ kind: "agent", name: "run" })], { thread: thread.id, model: "z-ai/glm-5.3-flash" });
  assert.equal(readTurn({ timestamp: "2026-08-20T00:00:00Z", text }, thread).model, "z-ai/glm-5.3-flash");
});

const proposal = (lever: Lever, addition: string, scope = "") => ({ title: lever, lever, metric: "failures" as const, addition, look: 1, ...(scope ? { scope } : {}) });

test("a lever's payload is read before it is stored, and a payload that cannot be read is not a change", () => {
  const good: [Lever, string, string][] = [
    ["instructions", "Read the file first.", ""],
    ["verifier", "Clear rm inside the workspace.", ""],
    ["prompt", "Answer in Polish.", "family:glm"],
    ["prompt", "Answer in Polish.", ""],
    ["tools", '{"grep_files":"Take this before rg."}', ""],
    ["advertise", "memory, plan", ""],
    ["knobs", "autoCompactPercent=55", ""],
  ];
  const bad: [Lever, string, string][] = [
    ["prompt", "Answer in Polish.", "family:nope"],
    ["prompt", "Answer in Polish.", "whatever"],
    ["tools", "grep_files is slow", ""],
    ["tools", '["grep_files"]', ""],
    ["tools", '{"grep_files":""}', ""],
    ["tools", '{"grep_files":3}', ""],
    ["advertise", " , ", ""],
    ["knobs", "autoCompactPercent=101", ""],
    ["knobs", "nonesuch=3", ""],
    ["knobs", "autoCompactPercent=half", ""],
    ["knobs", "semanticGrep=1", ""],
  ];
  for (const [lever, addition, scope] of good) {
    assert.equal(additionValid(lever, addition, scope), true, `${lever} refused ${addition} ${scope}`);
    assert.equal(startTrial([], proposal(lever, addition, scope), 9).length, 1, `${lever} did not start on ${addition}`);
    assert.equal(validateImprovements({ items: [{ id: "x", lever, addition, scope, state: "kept" }] }).items.length, 1);
  }
  for (const [lever, addition, scope] of bad) {
    assert.equal(additionValid(lever, addition, scope), false, `${lever} accepted ${addition} ${scope}`);
    assert.deepEqual(startTrial([], proposal(lever, addition, scope), 9), [], `${lever} started on ${addition}`);
    assert.deepEqual(validateImprovements({ items: [{ id: "x", lever, addition, scope, state: "kept" }] }).items, []);
  }
});

test("what is kept reaches a turn as the payload its lever takes", () => {
  const use = applied({ items: [
    kept("p1", { lever: "prompt", addition: "Answer in Polish.", scope: "family:glm" }),
    kept("t1", { lever: "tools", addition: '{"grep_files":"Take this before rg."}' }),
    kept("t2", { lever: "tools", addition: '{"memory":"Read it first."}' }),
    kept("a1", { lever: "advertise", addition: "memory, plan" }),
    kept("k1", { lever: "knobs", addition: "autoCompactPercent=55" }),
  ] }, "z-ai/glm-5.3-flash");
  assert.deepEqual(use.kept.prompts, [{ body: "Answer in Polish.", scope: "family:glm" }]);
  assert.deepEqual(use.kept.toolHints, { grep_files: "Take this before rg.", memory: "Read it first." });
  assert.deepEqual(use.kept.preselect, ["memory", "plan"]);
  assert.deepEqual(use.kept.knobs, { autoCompactPercent: 55 });
});

test("where the tokens go is read off the same traces, per tool, per family and on discovery", () => {
  const text = encodeSpans([
    span({ kind: "agent", name: "run" }),
    span({ kind: "other", name: "select_tool", input: '{"name":"memory"}', tokens: 300 }),
    span({ kind: "other", name: "select_tool", startedAt: 2, input: '{"name":"memory"}', tokens: 100 }),
    span({ kind: "execute", name: "terminal", startedAt: 3, tokens: 1200 }),
    span({ kind: "verifier", startedAt: 4, tokens: 999 }),
  ], { thread: thread.id, model: "glm-5", family: "glm", requests: "4", in: "8000", out: "2000", cost: "70", discovery: "2" });
  const read = readTurn({ timestamp: "2026-08-20T00:00:00Z", text }, thread);
  assert.equal(read.family, "glm");
  assert.equal(read.discovery, 2);

  const rows = spendOf([read, { ...read, at: 2 }]);
  const of = (kind: Spend["kind"], name: string) => rows.find((row) => row.kind === kind && row.name === name);
  const terminal = of("tool", "terminal");
  assert.equal(terminal?.tokens, 2400, "a tool row is the tokens its own calls put in the window");
  assert.equal(terminal?.calls, 2);
  assert.equal(terminal?.turns, 2);
  assert.equal(of("tool", "verifier"), undefined, "a verifier review is not a tool");

  const family = of("family", "glm");
  assert.equal(family?.tokens, 10_000, "a family row is what an average turn on it costs");
  assert.equal(family?.requests, 4);
  assert.equal(family?.cost, 70);
  assert.equal(family?.turns, 2);

  const discovery = of("discovery", "discovery");
  assert.equal(discovery?.turns, 2);
  assert.equal(discovery?.steps, 2, "mean steps spent finding a tool");
  assert.deepEqual(discovery?.picked, ["memory"], "and which tool it kept picking");
  assert.equal(discovery?.tokens, 800);
  assert.deepEqual(rows.map((row) => row.tokens), [...rows.map((row) => row.tokens)].sort((left, right) => right - left), "the ranking number is the tokens");
  assert.deepEqual(spendOf([]), []);
});

test("a spend row proposes the lever that would move it, and a blank tool description starts nothing", () => {
  const rows = spendOf([readTurn({
    timestamp: "2026-08-20T00:00:00Z",
    text: encodeSpans([
      span({ kind: "agent", name: "run" }),
      span({ kind: "other", name: "select_tool", input: '{"name":"memory"}', tokens: 300 }),
    ], { thread: thread.id, model: "glm-5", family: "glm", requests: "3", in: "9000", out: "1000", discovery: "3" }),
  }, thread)]);

  const discovery = draftProposal(rows.find((row) => row.kind === "discovery")!)!;
  assert.equal(discovery.lever, "advertise");
  assert.equal(discovery.metric, "requests");
  assert.equal(discovery.addition, "memory");
  assert.equal(additionValid(discovery.lever, discovery.addition, discovery.scope ?? ""), true);

  const family = draftProposal(rows.find((row) => row.kind === "family")!)!;
  assert.equal(family.lever, "prompt");
  assert.equal(family.metric, "tokens");
  assert.equal(family.scope, "family:glm");
  assert.equal(additionValid(family.lever, family.addition, family.scope ?? ""), true);

  assert.equal(draftProposal(rows.find((row) => row.kind === "tool")!), null, "a tool's tokens are not by themselves a change to make");

  const shaped = span({ kind: "other", name: "memory", status: "failed", output: 'Invalid arguments: "note" must be a bare JSON string' });
  const turnText = encodeSpans([span({ kind: "agent", name: "run" }), shaped], { thread: thread.id });
  const failing = readTurn({ timestamp: "2026-08-20T00:00:00Z", text: turnText }, thread);
  const [item] = frictionOf([failing, { ...failing, at: 2 }]);
  const tools = draftProposal(item);
  assert.equal(tools.lever, "tools");
  assert.equal(tools.metric, "failures");
  assert.equal(tools.addition, '{"memory":""}');
  assert.equal(additionValid(tools.lever, tools.addition), false, "the drafted hint is a blank the user fills, so nothing starts until it is written");
  assert.deepEqual(startTrial([], { ...tools, title: tools.title }, 9), [], "and Start stays disabled on it");
  assert.equal(additionValid(tools.lever, '{"memory":"Pass note as a string."}'), true);

  const plain = span({ kind: "other", name: "memory", status: "failed", output: "the file was not there" });
  const other = readTurn({ timestamp: "2026-08-20T00:00:00Z", text: encodeSpans([span({ kind: "agent", name: "run" }), plain], { thread: thread.id }) }, thread);
  assert.equal(draftProposal(frictionOf([other, { ...other, at: 2 }])[0]).lever, "instructions", "a failure that is not an argument shape is still a lesson");
});
