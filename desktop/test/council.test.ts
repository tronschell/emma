import test from "node:test";
import assert from "node:assert/strict";
import { body, councilAnswer, headline } from "../main/council";
import { addressed, councilAutoPicks, councilCalls, councilSpend, seatSpend, usdLabel, validateCouncilStart, type CouncilState } from "../shared/council";

const seats = [
  { id: "a", model: "openrouter:openai/gpt-5.6", name: "gpt-5.6" },
  { id: "b", model: "openrouter:google/gemini-3-pro", name: "gemini-3-pro" },
];

const state: CouncilState = {
  threadId: "thread-1",
  question: "Which cache do we keep?",
  phase: "waiting",
  mode: "ask",
  seats,
  voices: [
    { seatId: "a", round: "draft", text: "TAKE: keep the LRU\nIt is already there.", at: 1, error: "", inputTokens: 1_000, outputTokens: 200, microDollars: 40, plan: "" },
    { seatId: "b", round: "draft", text: "TAKE: drop it\nNothing measures it.", at: 2, error: "", inputTokens: 800, outputTokens: 150, microDollars: 0, plan: "zai" },
    { seatId: "b", round: "discuss", text: "GPT is right that it is already there, but nothing measures it.", at: 3, error: "", inputTokens: 900, outputTokens: 90, microDollars: 0, plan: "zai" },
  ],
  chairId: "a",
  floor: "",
  winnerId: "",
  verdict: "Keep it.",
  error: "",
  startedAt: 0,
};

test("a seat's opening line is its TAKE, not its first sentence", () => {
  assert.equal(headline(state.voices[0].text), "keep the LRU");
  assert.equal(headline("No marker here.\nSecond line."), "No marker here.");
  assert.equal(body(state.voices[0].text), "It is already there.");
});

test("a turn addresses the seats it names, by short handle when that is unambiguous", () => {
  assert.deepEqual(addressed(seats, state.voices[2].text, "b"), ["a"]);
  assert.deepEqual(addressed(seats, "I agree with gemini-3-pro here.", "a"), ["b"]);
  assert.deepEqual(addressed(seats, "Nobody in particular.", "a"), []);
  const twins = [...seats, { id: "c", model: "openrouter:openai/gpt-5.6-mini", name: "gpt-5.6-mini" }];
  assert.deepEqual(addressed(twins, "GPT should measure first.", "b"), []);
  assert.deepEqual(addressed(twins, "gpt-5.6-mini should measure first.", "b"), ["c"]);
});

test("the landed answer is the council's, or one draft when the user takes it alone", () => {
  assert.match(councilAnswer(state), /^Keep it\.\n\n---\nCouncil of 2, chaired by gpt-5\.6, 1 turns\. Opening positions:\n- gpt-5\.6 — keep the LRU\n- gemini-3-pro — drop it$/);
  assert.match(councilAnswer({ ...state, winnerId: "b" }), /^Nothing measures it\.\n\n---\nCouncil of 2, chaired by gpt-5\.6, 1 turns, gemini-3-pro's draft taken as-is\./);
  assert.equal(councilCalls(5), 16);
});

test("spend adds up per seat and across the room, and names every plan drawn on", () => {
  const total = councilSpend(state);
  assert.equal(total.calls, 3);
  assert.equal(total.inputTokens, 2_700);
  assert.equal(total.microDollars, 40);
  assert.deepEqual(total.plans, ["zai"]);
  assert.equal(seatSpend(state, "b").outputTokens, 240);
  assert.equal(seatSpend(state, "b").plan, "zai");
  assert.equal(usdLabel(40), "$0.0000");
  assert.equal(usdLabel(2_500_000), "$2.50");
  assert.equal(usdLabel(0), "$0");
});

test("only Ask leaves the choice to the user", () => {
  assert.equal(councilAutoPicks("ask"), false);
  assert.equal(councilAutoPicks("acceptEdits"), true);
  assert.equal(councilAutoPicks("auto"), true);
  assert.equal(councilAutoPicks("full"), true);
});

test("a council request is bounded where it arrives", () => {
  const start = { threadId: "thread-1", question: "Which cache?", mode: "auto", seats };
  assert.deepEqual(validateCouncilStart(start).seats.length, 2);
  assert.throws(() => validateCouncilStart({ ...start, mode: "whatever" }), /permission mode/);
  assert.throws(() => validateCouncilStart({ ...start, seats: [seats[0]] }), /seats between/);
  assert.throws(() => validateCouncilStart({ ...start, seats: [seats[0], { ...seats[1], id: "a" } ] }), /share an id/);
  assert.throws(() => validateCouncilStart({ ...start, question: "" }), /question/);
  assert.throws(() => validateCouncilStart({ ...start, question: "x".repeat(9_000) }), /question/);
  assert.throws(() => validateCouncilStart({ ...start, seats: [seats[0], { id: "b", model: "", name: "x" }] }), /seat model/);
  assert.throws(() => validateCouncilStart(null), /not readable/);
});
