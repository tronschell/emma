import { COUNCIL_PASSES, councilAutoPicks, councilRunning, type CouncilRound, type CouncilSeat, type CouncilState, type CouncilStart, type CouncilVoice } from "../shared/council";
import type { VerifierSettings } from "../shared/settings";
import { chatCompletion, type ChatMessage } from "./verifier";

const DRAFT_TOKENS = 800;
const TURN_TOKENS = 360;
const ANSWER_TOKENS = 1_400;
const SEAT_TIMEOUT_MS = 120_000;
const CARRIED_CHARS = 6_000;
const QUOTED_CHARS = 1_200;
const TURN_CHARS = 900;

export type CouncilRoute = { settings: VerifierSettings; apiKey: string; modelId: string; plan: string };

export type CouncilDeps = {
  route: (model: string) => CouncilRoute;
  rates: (modelId: string) => { input: number; output: number };
  emit: (state: CouncilState) => void;
  land: (state: CouncilState) => Promise<void>;
  carried: (threadId: string) => Promise<string>;
};

let deps: CouncilDeps | undefined;

export function configureCouncil(next: CouncilDeps) {
  deps = next;
}

type Sitting = { state: CouncilState; stopped: boolean };

const sittings = new Map<string, Sitting>();

export const councilState = (threadId: string) => sittings.get(threadId)?.state;

export function stopCouncil(threadId: string) {
  const sitting = sittings.get(threadId);
  if (!sitting) return;
  sitting.stopped = true;
  if (councilRunning(sitting.state.phase)) {
    sitting.state = { ...sitting.state, phase: "stopped", floor: "" };
    deps!.emit(sitting.state);
  }
}

export function closeCouncil(threadId: string) {
  sittings.delete(threadId);
}

const clip = (value: string, max: number) => value.length > max ? `${value.slice(0, max)}…` : value;

export function headline(text: string): string {
  const line = text.split("\n").find((row) => /^\s*TAKE:/i.test(row));
  const said = line ? line.replace(/^\s*TAKE:\s*/i, "").trim() : text.trim().split("\n")[0] ?? "";
  return clip(said.replace(/[*_`#]/g, ""), 90);
}

export function body(text: string): string {
  return text.split("\n").filter((row) => !/^\s*TAKE:/i.test(row)).join("\n").trim();
}

const roster = (seats: readonly CouncilSeat[]) => seats.map((seat) => seat.name).join(", ");

const draftSystem = (seat: CouncilSeat, seats: readonly CouncilSeat[]) => [
  `You are ${seat.name}, one of ${seats.length} models on a council: ${roster(seats)}. The council has to agree on one answer, and this is your opening position.`,
  "Answer alone. You have no tools and cannot read files or run commands, so reason from what you are given and say plainly what would have to be checked.",
  "Open with one line beginning \"TAKE: \" — your position in at most twelve words. Then the answer, at most 250 words. No preamble.",
].join("\n");

const turnSystem = (seat: CouncilSeat, seats: readonly CouncilSeat[]) => [
  `You are ${seat.name} on a council of ${seats.length}: ${roster(seats)}. Every seat has drafted; now the council talks it through to reach one answer.`,
  "It is your turn. Speak to the others by name: concede what they got right, push back where they are wrong, and move the room toward one answer. If you now agree with the direction, say so and add what is still missing.",
  "At most 120 words. No preamble, no headings, do not restate your draft.",
].join("\n");

const answerSystem = (chair: CouncilSeat, seats: readonly CouncilSeat[]) => [
  `You are ${chair.name} and you chair this council of ${seats.length}. The drafts and the whole discussion are in front of you.`,
  "Write the answer the council arrived at, taking what the discussion improved. Where seats still disagree, say so in one line rather than papering over it. At most 500 words. No preamble.",
].join("\n");

const seatName = (state: CouncilState, seatId: string) => state.seats.find((seat) => seat.id === seatId)?.name ?? seatId;

function drafts(state: CouncilState): string {
  return state.voices
    .filter((voice) => voice.round === "draft" && !voice.error && voice.text)
    .map((voice) => `--- ${seatName(state, voice.seatId)} ---\n${clip(body(voice.text), QUOTED_CHARS)}`)
    .join("\n\n");
}

function discussion(state: CouncilState): string {
  return state.voices
    .filter((voice) => voice.round === "discuss" && !voice.error && voice.text)
    .map((voice) => `${seatName(state, voice.seatId)}: ${clip(voice.text, TURN_CHARS)}`)
    .join("\n\n");
}

const table = (state: CouncilState, question: string) =>
  `The question:\n${question}\n\nOpening drafts:\n${drafts(state)}\n\nThe discussion so far:\n${discussion(state) || "(nobody has spoken yet)"}`;

async function speak(seat: CouncilSeat, round: CouncilRound, messages: ChatMessage[], maxTokens: number): Promise<CouncilVoice> {
  const voice: CouncilVoice = { seatId: seat.id, round, text: "", at: Date.now(), error: "", inputTokens: 0, outputTokens: 0, microDollars: 0, plan: "" };
  try {
    const route = deps!.route(seat.model);
    voice.plan = route.plan;
    const rates = deps!.rates(route.modelId);
    const text = await chatCompletion(route.settings, messages, route.apiKey, {
      maxTokens,
      timeoutMs: SEAT_TIMEOUT_MS,
      label: "council",
      onUsage: (usage) => {
        voice.inputTokens = usage.inputTokens;
        voice.outputTokens = usage.outputTokens;
        voice.microDollars = Math.round((usage.inputTokens * rates.input + usage.outputTokens * rates.output) / 1_000_000);
      },
    });
    voice.text = text.trim();
    if (!voice.text) voice.error = "answered with nothing";
  } catch (error) {
    voice.error = error instanceof Error ? error.message : String(error);
  }
  voice.at = Date.now();
  return voice;
}

async function turn(sitting: Sitting, seat: CouncilSeat, round: CouncilRound, messages: ChatMessage[], maxTokens: number) {
  const voice = await speak(seat, round, messages, maxTokens);
  if (sitting.stopped) return voice;
  sitting.state = { ...sitting.state, voices: [...sitting.state.voices, voice] };
  deps!.emit(sitting.state);
  return voice;
}

const spoke = (state: CouncilState, round: CouncilRound) => state.voices.some((voice) => voice.round === round && !voice.error);

export async function startCouncil(request: CouncilStart): Promise<CouncilState> {
  if (!deps) throw new Error("The council is not wired up yet.");
  const running = sittings.get(request.threadId);
  if (running && councilRunning(running.state.phase)) throw new Error("This thread already has a council sitting. Stop it before you seat another.");
  const sitting: Sitting = {
    stopped: false,
    state: {
      threadId: request.threadId,
      question: request.question,
      phase: "drafting",
      mode: request.mode,
      seats: request.seats,
      voices: [],
      chairId: request.seats[0].id,
      floor: "",
      winnerId: "",
      verdict: "",
      error: "",
      startedAt: Date.now(),
    },
  };
  sittings.set(request.threadId, sitting);
  deps.emit(sitting.state);
  void sit(sitting).catch((error: unknown) => {
    sitting.state = { ...sitting.state, phase: "failed", floor: "", error: error instanceof Error ? error.message : String(error) };
    deps!.emit(sitting.state);
  });
  return sitting.state;
}

function move(sitting: Sitting, patch: Partial<CouncilState>) {
  sitting.state = { ...sitting.state, ...patch };
  deps!.emit(sitting.state);
}

async function sit(sitting: Sitting) {
  const seats = sitting.state.seats;
  const carried = clip(await deps!.carried(sitting.state.threadId), CARRIED_CHARS);
  const asked = carried ? `What the thread has covered so far:\n${carried}\n\nThe question:\n${sitting.state.question}` : sitting.state.question;

  await Promise.all(seats.map((seat) => turn(sitting, seat, "draft", [
    { role: "system", content: draftSystem(seat, seats) },
    { role: "user", content: asked },
  ], DRAFT_TOKENS)));
  if (sitting.stopped) return;
  if (!spoke(sitting.state, "draft")) {
    move(sitting, { phase: "failed", error: "No seat answered. Check the keys behind these models." });
    return;
  }

  move(sitting, { phase: "discussing" });
  for (let pass = 0; pass < COUNCIL_PASSES; pass++) {
    for (const seat of seats) {
      if (sitting.stopped) return;
      move(sitting, { floor: seat.id });
      await turn(sitting, seat, "discuss", [
        { role: "system", content: turnSystem(seat, seats) },
        { role: "user", content: table(sitting.state, sitting.state.question) },
      ], TURN_TOKENS);
    }
  }
  if (sitting.stopped) return;

  const chair = seats.find((seat) => seat.id === sitting.state.chairId) ?? seats[0];
  move(sitting, { phase: "deciding", floor: chair.id });
  const answer = await turn(sitting, chair, "verdict", [
    { role: "system", content: answerSystem(chair, seats) },
    { role: "user", content: table(sitting.state, asked) },
  ], ANSWER_TOKENS);
  if (sitting.stopped) return;
  if (answer.error) {
    move(sitting, { phase: "failed", floor: "", error: `The chair could not write it up: ${answer.error}` });
    return;
  }
  move(sitting, { floor: "", verdict: body(answer.text), phase: councilAutoPicks(sitting.state.mode) ? "done" : "waiting" });
  if (sitting.state.phase === "done") await deps!.land(sitting.state);
}

export async function adoptCouncil(threadId: string, seatId: string): Promise<CouncilState> {
  const sitting = sittings.get(threadId);
  if (!sitting || sitting.state.phase !== "waiting") throw new Error("That council is not waiting on you.");
  move(sitting, { winnerId: sitting.state.seats.some((seat) => seat.id === seatId) ? seatId : "", phase: "done" });
  await deps!.land(sitting.state);
  return sitting.state;
}

export function councilAnswer(state: CouncilState): string {
  const winner = state.seats.find((seat) => seat.id === state.winnerId);
  const draft = winner ? state.voices.find((voice) => voice.seatId === winner.id && voice.round === "draft") : undefined;
  const taken = draft && !draft.error ? body(draft.text) : state.verdict;
  const turns = state.voices.filter((voice) => voice.round === "discuss" && !voice.error).length;
  const positions = state.seats.map((seat) => {
    const voice = state.voices.find((item) => item.seatId === seat.id && item.round === "draft");
    return `- ${seat.name} — ${voice?.error ? `stalled: ${voice.error}` : headline(voice?.text ?? "")}`;
  }).join("\n");
  return [
    taken,
    "",
    "---",
    `Council of ${state.seats.length}, chaired by ${seatName(state, state.chairId)}, ${turns} turns${winner ? `, ${winner.name}'s draft taken as-is` : ""}. Opening positions:`,
    positions,
  ].join("\n");
}
