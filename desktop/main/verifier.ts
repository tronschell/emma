/* Auto mode's second model.
 *
 * In `auto`, a call that would stop and ask the user is put to a separate model
 * first: here is what the user asked for, here is the command the agent wants to
 * run, is it safe. It clears the call or it does not — a refusal is not a veto,
 * it falls back to asking the person, which is what `ask` would have done anyway.
 *
 * The model is deliberately small — a 2.6B on a free route by default — so this
 * file assumes it will get the answer format wrong and reads the reply loosely,
 * then asks again with the mistake quoted back at it. Everything the model was
 * sent and everything it said is returned, because an approval nobody can read
 * afterwards is worse than the dialog it replaced.
 */

import { defaultVerifierSystem, type VerifierSettings } from "../shared/settings";

/* The rules live in shared/settings because they are a setting: the user edits
   them in Settings → Models, and both sides of the IPC boundary read the same text. */
export { PROHIBITED, defaultVerifierSystem } from "../shared/settings";

/** Small model, one sentence of reasoning. Longer than this and the dialog would have been faster. */
const VERIFIER_TIMEOUT = 20_000;
/** One JSON line is thirty tokens; the rest is headroom for a model that thinks before it answers. */
const VERIFIER_MAX_TOKENS = 700;
/** Attempts at a readable verdict. Two retries is where a 2.6B either has it or does not. */
const MAX_ATTEMPTS = 3;
/** Enough for a command, a path, or an argument list; the rest is never what makes a call dangerous. */
const MAX_DETAIL_CHARS = 2_000;

export type Verdict = { allow: boolean; reason: string };

/** What the agent wants to do, as the verifier is told it. */
export type VerifierRequest = {
  /** What the user actually asked for this turn. */
  goal: string;
  /** The thread this is happening in, for when the goal is a one-liner. */
  title: string;
  /** What the agent is doing right now, in Emma's own words. */
  activity: string;
  tool: string;
  summary: string;
  /** The argument worth reading before approving: a command line, a path. */
  detail: string;
};

/** One review, kept whole: what went to the model, what came back, and how many tries it took. */
export type VerifierReview = {
  model: string;
  prompt: string;
  reply: string;
  /** Absent when the model never answered readably, which is the same as a refusal to clear it. */
  verdict?: Verdict;
  error?: string;
  attempts: number;
};

const clamp = (value: string, max: number) => value.length > max ? `${value.slice(0, max)}…` : value;

/** The user half of the request, which is also what the transcript shows as the context. */
export function verifierPrompt(request: VerifierRequest): string {
  return [
    `Thread: ${clamp(request.title || "Untitled", 200)}`,
    `The user asked: ${clamp(request.goal || "(nothing recorded)", MAX_DETAIL_CHARS)}`,
    `The agent is currently: ${clamp(request.activity || "working", 200)}`,
    "",
    `Proposed action: ${request.tool}`,
    `Summary: ${clamp(request.summary, 400)}`,
    request.detail ? `Exactly what it will run:\n${clamp(request.detail, MAX_DETAIL_CHARS)}` : "It carries no further arguments.",
    "",
    "Is it safe to run this now? Answer with the JSON line.",
  ].join("\n");
}

/**
 * A verdict out of whatever the model said, or undefined when it said nothing
 * usable.
 *
 * Loose on purpose: a small model that returns `ALLOW`, or wraps its JSON in a
 * code fence, or writes a sentence before it, has still answered the question,
 * and burning a retry on punctuation only makes the wait longer.
 */
export function parseVerdict(reply: string): Verdict | undefined {
  // Thinking is not the answer: a reasoning model puts the verdict after the
  // block, and an unterminated one means it never got there at all.
  const text = reply.replace(/<(think|thinking|reasoning)>[\s\S]*?(?:<\/\1>|$)/gi, "").trim();
  if (!text) return undefined;
  for (const candidate of jsonObjects(text)) {
    const allow = truth(candidate.allow ?? candidate.allowed ?? candidate.safe ?? candidate.approve ?? candidate.approved ?? candidate.verdict ?? candidate.decision ?? candidate.answer);
    if (allow === undefined) continue;
    const reason = candidate.reason ?? candidate.reasoning ?? candidate.why ?? candidate.explanation;
    return { allow, reason: typeof reason === "string" ? clamp(reason.trim(), 300) : "" };
  }
  // No JSON anywhere, so the bare word it opened with is the whole answer — but
  // only when it stands as one. "Blocked: …" and "ALLOW — …" are verdicts; "No
  // idea what you mean" is a word that happens to start with one, and treating
  // that as a refusal would put a made-up reason in front of the user.
  const bare = /^[^A-Za-z]*(allow|approved?|safe|yes|deny|denied|block(?:ed)?|unsafe|no)(?:\s*[^\sA-Za-z0-9]|\s*\n|\s*$)/i.exec(text);
  if (!bare) return undefined;
  return { allow: truth(bare[1]) === true, reason: clamp(text.replace(/\s+/g, " "), 300) };
}

/** Every `{…}` in the text, parsed, outermost first: the reply may be fenced, prefixed, or both. */
function jsonObjects(text: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    for (let end = text.lastIndexOf("}"); end > start; end = text.lastIndexOf("}", end - 1)) {
      try {
        const value: unknown = JSON.parse(text.slice(start, end + 1));
        if (value && typeof value === "object" && !Array.isArray(value)) found.push(value as Record<string, unknown>);
        break;
      } catch { /* not a complete object at this pair; try the next closer */ }
    }
  }
  return found;
}

/** The many ways a small model says yes and no, including the ones that are not booleans. */
function truth(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return undefined;
  const word = value.trim().toLowerCase();
  if (["true", "yes", "y", "allow", "allowed", "approve", "approved", "safe", "ok", "1"].includes(word)) return true;
  if (["false", "no", "n", "deny", "denied", "block", "blocked", "reject", "rejected", "unsafe", "0"].includes(word)) return false;
  return undefined;
}

/** A message part, for the one caller that sends more than text: the vision tool. */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string | ContentPart[] };

/**
 * Asks the verifier, retrying an unreadable answer with its own reply quoted back.
 *
 * Never throws: every failure — no model configured, no key, a dead endpoint, a
 * model that will not answer in the format — comes back as a review without a
 * verdict, and the caller falls back to asking the user.
 */
export async function review(settings: VerifierSettings, request: VerifierRequest, fetchJson = chat): Promise<VerifierReview> {
  const prompt = verifierPrompt(request);
  const base: VerifierReview = { model: settings.model, prompt, reply: "", attempts: 0 };
  if (!settings.model || !settings.endpoint) return { ...base, error: "No verifier model is configured in Settings → Models." };
  const key = settings.credentialEnv ? process.env[settings.credentialEnv] : "";
  if (settings.credentialEnv && !key) return { ...base, error: `${settings.credentialEnv} is not stored, so the verifier cannot be reached.` };
  const messages: ChatMessage[] = [{ role: "system", content: settings.system || defaultVerifierSystem }, { role: "user", content: prompt }];
  let last = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let reply: string;
    try {
      reply = await fetchJson(settings, messages, key ?? "");
    } catch (error) {
      // A transport failure will not be fixed by asking again in the same second.
      return { ...base, reply: last, attempts: attempt, error: error instanceof Error ? error.message : String(error) };
    }
    last = reply;
    const verdict = parseVerdict(reply);
    if (verdict) return { ...base, reply, verdict, attempts: attempt };
    // Nothing came back at all — usually a thinking model that ran out of budget
    // before the answer. Quoting silence back at it teaches it nothing, so just
    // ask again and tell it to skip the reasoning.
    if (!reply.trim()) messages.push({ role: "user", content: 'You returned nothing. Do not reason. Reply with one line: {"allow": true, "reason": "short reason"}' });
    else {
      messages.push({ role: "assistant", content: reply.slice(0, 500) });
      messages.push({ role: "user", content: 'That was not the answer format. Reply with one line and nothing else, exactly like this: {"allow": true, "reason": "short reason"}' });
    }
  }
  return {
    ...base,
    reply: last,
    attempts: MAX_ATTEMPTS,
    error: last.trim() ? "The verifier never answered in the required format." : "The verifier returned an empty reply every time; it may be a reasoning model with no room left for an answer.",
  };
}

const chat = (settings: VerifierSettings, messages: ChatMessage[], key: string) =>
  chatCompletion(settings, messages, key, { maxTokens: VERIFIER_MAX_TOKENS, timeoutMs: VERIFIER_TIMEOUT, label: "verifier" });

/**
 * One OpenAI-compatible chat completion against a second model's route.
 *
 * Split out so the verifier's retry loop can be tested without a network, and
 * shared with the advisor because it is the same request to the same shape of
 * endpoint — only the size of the model and the size of the answer differ.
 */
export async function chatCompletion(
  settings: VerifierSettings,
  messages: ChatMessage[],
  key: string,
  { maxTokens, timeoutMs, label }: { maxTokens: number; timeoutMs: number; label: string },
): Promise<string> {
  // The model may be a chain — a router picked in Settings arrives as `a,b,c`,
  // best first. OpenRouter's own `models` array does the falling through, so a
  // rate-limited free verifier is answered by the next name instead of a 429.
  // The primary is repeated as `model` for endpoints that never heard of it.
  const [primary, ...rest] = settings.model.split(",").map((id) => id.trim()).filter(Boolean);
  const response = await fetch(settings.endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ model: primary ?? settings.model, ...(rest.length ? { models: [primary, ...rest] } : {}), messages, temperature: 0, max_tokens: maxTokens, stream: false }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`The ${label} endpoint answered ${response.status}.`);
  const body = await response.json() as { choices?: { message?: { content?: unknown; reasoning?: unknown } }[] };
  const message = body.choices?.[0]?.message;
  const content = typeof message?.content === "string" ? message.content : "";
  // A thinking model that spends the whole budget reasoning answers with empty
  // content and its thoughts in `reasoning`. The verdict, if it reached one, is
  // in there, and an empty string is not something a retry can improve on.
  return content || (typeof message?.reasoning === "string" ? message.reasoning : "");
}
