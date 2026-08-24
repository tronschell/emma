/* The categorizer: the second model that files a thread under one of the tags the
 * user has already applied by hand.
 *
 * The same shape as the advisor and the vision tool — main holds the route and the
 * key, and the answer comes back as words — with one difference that matters: no
 * agent chooses to call this. The renderer does, once the user's own filing has
 * taught it a category, and the tag it gets back is a suggestion the user can
 * retype or clear.
 *
 * Nothing here decides *whether* to file. That gate is `learnedFrom` in
 * `src/context.ts`, which the knowledge pages share.
 */

import { chatCompletion, type ChatMessage } from "./verifier";
import { tagName, type TaggerSettings } from "../shared/settings";

/** One word out of a small model. Long enough for a busy free route, short of a stalled sweep. */
const TAGGER_TIMEOUT = 20_000;
/** A tag is a word. The ceiling is for a model that narrates before it answers. */
const TAGGER_MAX_TOKENS = 32;
/** How much of a thread travels. Past the opening exchange, more text is not a better tag. */
export const MAX_TAGGER_TEXT_CHARS = 4_000;
/** Ceiling on the list and the examples, so a corrupted store cannot become an unbounded prompt. */
export const MAX_THREAD_TAGS = 32;

/** The user's categories, a few threads they filed themselves, and the thread to file. */
export type TagRequest = {
  text: string;
  tags: string[];
  examples: { tag: string; text: string }[];
};

/**
 * The thread as the categorizer reads it, quoted so a prompt inside somebody's own
 * conversation cannot be mistaken for an instruction addressed to the model doing
 * the filing. It is being shown a conversation, not joining one.
 */
export function taggerPrompt({ text, tags, examples }: TagRequest): string {
  return [
    "The user's tags:",
    ...tags.map((tag) => `- ${tag}`),
    "",
    ...(examples.length ? ["Threads they filed themselves:", ...examples.map((item) => `- ${item.tag}: ${item.text}`), ""] : []),
    "The thread to file:",
    "<<<THREAD",
    text.slice(0, MAX_TAGGER_TEXT_CHARS),
    "THREAD>>>",
    "",
    `Answer with one of: ${tags.join(", ")}, none.`,
  ].join("\n");
}

/**
 * Asks for a tag and returns one off the list, or "" for none.
 *
 * Never throws, and never returns a tag the user did not make: the reply is matched
 * against the list rather than parsed, so a model that answers "Tag: billing." and
 * one that invents a category both land somewhere safe. Longest match wins, so
 * "billing" cannot be answered by a reply that meant "billing-eu".
 */
export async function tagThread(settings: TaggerSettings, request: TagRequest, ask = chatCompletion): Promise<{ tag: string; error?: string }> {
  const tags = [...new Set(request.tags.map(tagName).filter(Boolean))];
  if (!settings.model.trim() || !settings.endpoint.trim() || !tags.length) return { tag: "", error: "No categorizer model is configured in Settings → Models." };
  const key = settings.credentialEnv ? process.env[settings.credentialEnv] : "";
  if (settings.credentialEnv && !key) return { tag: "", error: `${settings.credentialEnv} is not stored, so the categorizer cannot be reached.` };
  const messages: ChatMessage[] = [
    { role: "system", content: settings.system },
    { role: "user", content: taggerPrompt({ ...request, tags }) },
  ];
  try {
    const reply = (await ask(settings, messages, key ?? "", { maxTokens: TAGGER_MAX_TOKENS, timeoutMs: TAGGER_TIMEOUT, label: "categorizer" })).toLowerCase();
    return { tag: pickTag(reply, tags) };
  } catch (error) {
    return { tag: "", error: error instanceof Error ? error.message : String(error) };
  }
}

/** Which of the user's tags the reply named, if any. Exported for the check in `test/`. */
export function pickTag(reply: string, tags: string[]): string {
  // A reply that says "none" is the model declining, and every tag is a substring
  // of some sentence, so the refusal has to be read before the matching.
  if (/\bnone\b/.test(reply)) return "";
  return [...tags].sort((left, right) => right.length - left.length).find((tag) => reply.includes(tag)) ?? "";
}
