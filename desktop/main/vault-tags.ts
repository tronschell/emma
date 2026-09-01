import { chatCompletion, type ChatMessage } from "./verifier";
import { defaultTagger, defaultTaggerSystem, type TaggerSettings } from "../shared/settings";
import { MAX_TAGS, MAX_TITLE_BYTES, tagName, validTag, type KeptNote } from "../shared/vault";

const TAG_TIMEOUT = 20_000;
const TAG_MAX_TOKENS = 1_024;
export const MAX_TAG_TEXT_CHARS = 6_000;

export function tagPrompt(note: KeptNote, body: string): string {
  return [
    `Kind: ${note.kind}`,
    ...(note.sourceUrl ? [`Source: ${note.sourceUrl}`] : []),
    ...(note.sourceApplication ? [`Application: ${note.sourceApplication}`] : []),
    `Saved as: ${note.title}`,
    "",
    "The note:",
    "<<<NOTE",
    body.slice(0, MAX_TAG_TEXT_CHARS),
    "NOTE>>>",
  ].join("\n");
}

export function readTagReply(reply: string): { title: string; tags: string[] } | null {
  const text = reply.replace(/<(think|thinking|reasoning)>[\s\S]*?(?:<\/\1>|$)/gi, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const answer = parsed as { title?: unknown; tags?: unknown };
  const title = typeof answer.title === "string" ? answer.title.trim().replace(/\s+/g, " ").slice(0, MAX_TITLE_BYTES) : "";
  const tags = Array.isArray(answer.tags)
    ? [...new Set(answer.tags.map((item) => typeof item === "string" ? tagName(item) : "").filter(validTag))].slice(0, MAX_TAGS)
    : [];
  return title || tags.length ? { title, tags } : null;
}

export async function tagNote(
  note: KeptNote,
  body: string,
  settings: TaggerSettings = defaultTagger,
  ask = chatCompletion,
): Promise<{ title: string; tags: string[] } | null> {
  if (!settings?.model?.trim() || !settings?.endpoint?.trim()) return null;
  const key = settings.credentialEnv ? process.env[settings.credentialEnv] : "";
  if (settings.credentialEnv && !key) return null;
  const messages: ChatMessage[] = [
    { role: "system", content: settings.system?.trim() || defaultTaggerSystem },
    { role: "user", content: tagPrompt(note, body) },
  ];
  try {
    return readTagReply(await ask(settings, messages, key ?? "", { maxTokens: TAG_MAX_TOKENS, timeoutMs: TAG_TIMEOUT, label: "note tagger" }));
  } catch {
    return null;
  }
}
