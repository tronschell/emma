import { PERMISSION_MODES, type PermissionMode } from "./permissions";

export const COUNCIL_SEATS_MIN = 2;
export const COUNCIL_SEATS_MAX = 8;
export const COUNCIL_SEATS_DEFAULT = 5;
export const COUNCIL_QUESTION_MAX = 8_000;
export const COUNCIL_PASSES = 2;
export const councilCalls = (seats: number) => seats * (COUNCIL_PASSES + 1) + 1;
export const COUNCIL_VIEWS = ["bench", "table", "chat"] as const;

export type CouncilView = typeof COUNCIL_VIEWS[number];
export type CouncilPhase = "drafting" | "discussing" | "deciding" | "waiting" | "done" | "stopped" | "failed";
export type CouncilRound = "draft" | "discuss" | "verdict";

export type CouncilSeat = { id: string; model: string; name: string };

export type CouncilVoice = {
  seatId: string;
  round: CouncilRound;
  text: string;
  at: number;
  error: string;
  inputTokens: number;
  outputTokens: number;
  microDollars: number;
  plan: string;
};

export type CouncilState = {
  threadId: string;
  question: string;
  phase: CouncilPhase;
  mode: PermissionMode;
  seats: CouncilSeat[];
  voices: CouncilVoice[];
  chairId: string;
  floor: string;
  winnerId: string;
  verdict: string;
  error: string;
  startedAt: number;
};

export type CouncilStart = { threadId: string; question: string; mode: PermissionMode; seats: CouncilSeat[] };

export const councilAutoPicks = (mode: PermissionMode) => mode !== "ask";

export function councilSpend(state: CouncilState) {
  let inputTokens = 0;
  let outputTokens = 0;
  let microDollars = 0;
  const plans = new Set<string>();
  for (const voice of state.voices) {
    inputTokens += voice.inputTokens;
    outputTokens += voice.outputTokens;
    microDollars += voice.microDollars;
    if (voice.plan) plans.add(voice.plan);
  }
  return { inputTokens, outputTokens, microDollars, plans: [...plans], calls: state.voices.length };
}

export function seatSpend(state: CouncilState, seatId: string) {
  let inputTokens = 0;
  let outputTokens = 0;
  let microDollars = 0;
  let plan = "";
  for (const voice of state.voices) {
    if (voice.seatId !== seatId) continue;
    inputTokens += voice.inputTokens;
    outputTokens += voice.outputTokens;
    microDollars += voice.microDollars;
    plan ||= voice.plan;
  }
  return { inputTokens, outputTokens, microDollars, plan };
}

export function usdLabel(microDollars: number): string {
  if (microDollars <= 0) return "$0";
  if (microDollars < 10_000) return `$${(microDollars / 1_000_000).toFixed(4)}`;
  return `$${(microDollars / 1_000_000).toFixed(2)}`;
}

export function voiceFor(state: CouncilState, seatId: string, round: CouncilRound): CouncilVoice | undefined {
  return state.voices.find((voice) => voice.seatId === seatId && voice.round === round);
}

export function voicesFor(state: CouncilState, seatId: string, round: CouncilRound): CouncilVoice[] {
  return state.voices.filter((voice) => voice.seatId === seatId && voice.round === round);
}

const short = (seat: CouncilSeat) => seat.name.toLowerCase().split(/[-/\s:]/)[0] ?? "";

const mentions = (text: string, name: string) => new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9.-])`).test(text);

export function addressed(seats: readonly CouncilSeat[], text: string, speakerId: string): string[] {
  const lower = text.toLowerCase();
  return seats.filter((seat) => {
    if (seat.id === speakerId) return false;
    if (mentions(lower, seat.name.toLowerCase())) return true;
    const handle = short(seat);
    return !!handle && !seats.some((other) => other.id !== seat.id && short(other) === handle) && mentions(lower, handle);
  }).map((seat) => seat.id);
}

export const councilRunning = (phase: CouncilPhase) => phase === "drafting" || phase === "discussing" || phase === "deciding";

const text = (value: unknown, max: number, label: string): string => {
  if (typeof value !== "string") throw new Error(`The council ${label} is missing`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) throw new Error(`The council ${label} is out of range`);
  return trimmed;
};

export function validateCouncilStart(value: unknown): CouncilStart {
  if (!value || typeof value !== "object") throw new Error("That council request is not readable");
  const request = value as Record<string, unknown>;
  const mode = PERMISSION_MODES.find((candidate) => candidate === request.mode);
  if (!mode) throw new Error("That council request carries no permission mode");
  if (!Array.isArray(request.seats)) throw new Error("That council request seats nobody");
  if (request.seats.length < COUNCIL_SEATS_MIN || request.seats.length > COUNCIL_SEATS_MAX) {
    throw new Error(`A council seats between ${COUNCIL_SEATS_MIN} and ${COUNCIL_SEATS_MAX} models`);
  }
  const seats = request.seats.map((seat) => {
    const row = seat && typeof seat === "object" ? seat as Record<string, unknown> : {};
    return { id: text(row.id, 64, "seat id"), model: text(row.model, 256, "seat model"), name: text(row.name, 128, "seat name") };
  });
  if (new Set(seats.map((seat) => seat.id)).size !== seats.length) throw new Error("Two seats share an id");
  return { threadId: text(request.threadId, 128, "thread"), question: text(request.question, COUNCIL_QUESTION_MAX, "question"), mode, seats };
}
