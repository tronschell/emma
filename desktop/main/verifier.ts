import { type VerifierSettings } from "../shared/settings";
import { PROHIBITED } from "../shared/settings";

export { PROHIBITED, defaultVerifierSystem } from "../shared/settings";

const MAX_DETAIL_CHARS = 2_000;
const MAX_REASON_CHARS = 300;

export type Verdict = { allow: boolean; reason: string };

export type VerifierRequest = {
  goal: string;
  title: string;
  activity: string;
  tool: string;
  summary: string;
  detail: string;
};

export type VerifierReview = {
  model: string;
  prompt: string;
  reply: string;
  verdict?: Verdict;
  error?: string;
  attempts: number;
};

const clamp = (value: string, max: number) => value.length > max ? `${value.slice(0, max)}…` : value;

const unclamped = (value: string) => value.endsWith("…") ? value.slice(0, -1) : value;

export function verifierPrompt(request: VerifierRequest): string {
  const summary = clamp(request.summary, 400);
  const detail = request.detail ? clamp(request.detail, MAX_DETAIL_CHARS) : "";
  const repeated = !summary || summary === request.tool || detail.includes(unclamped(summary));
  return [
    `Thread: ${clamp(request.title || "Untitled", 200)}`,
    `The user asked: ${clamp(request.goal || "(nothing recorded)", MAX_DETAIL_CHARS)}`,
    `The agent is currently: ${clamp(request.activity || "working", 200)}`,
    "",
    `Proposed action: ${request.tool}`,
    ...(repeated ? [] : [`Summary: ${summary}`]),
    detail ? `Exactly what it will run:\n${detail}` : "It carries no further arguments.",
  ].join("\n");
}

type Guard = { rule: number; says: string; hit: RegExp };

const guards: Guard[] = [
  { rule: 0, says: "targets a system or home root", hit: /\b(rm|mv|dd|chmod|chown|shred)\b[^|;&]*\s(\/(System|Library|usr|etc|bin|sbin|Volumes)\b|~\/?(\s|$)|\$HOME\b|\/(\s|$)|\$\{?\w+\}?\/\*)/i },
  { rule: 1, says: "forces a recursive delete", hit: /\brm\s+(-\S*\s+)*-\S*(rf|fr)\b|\brm\b[^|;&]*--recursive[^|;&]*--force|\bfind\b[^|;&]*-delete\b/i },
  { rule: 2, says: "destroys version control history", hit: /\bgit\s+push\b[^|;&]*(--force\b|--force-with-lease\b|\s-f\b)|\bgit\s+reset\b[^|;&]*--hard\b|\bgit\s+clean\b[^|;&]*-\S*f|\bgit\s+(branch|tag)\s+-\S*[dD]\b|\bgit\s+stash\s+(drop|clear)\b|\bgit\s+(filter-branch|filter-repo)\b|\bgit\s+push\b[^|;&]*--delete\b/i },
  { rule: 3, says: "publishes or destroys something others read", hit: /\b(npm|pnpm|yarn)\s+publish\b|\bgh\s+release\s+create\b|\bdocker\s+push\b|\bkubectl\s+(apply|delete)\b|\b(drop|truncate)\s+(table|database)\b|\bdelete\s+from\b(?![^;]*\bwhere\b)/i },
  { rule: 4, says: "sends local content off this Mac", hit: /\bcurl\b[^|;&]*(-T\b|--upload-file\b|--data-binary\s*@|-d\s*@|-F\s+\S*@)|\bscp\b|\brsync\b[^|;&]*\s\S+@\S+:|\bnc\b[^|;&]*\s<\s*\S/i },
  { rule: 5, says: "downloads and runs code", hit: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|d)?sh\b|\b(curl|wget)\b[^|;&]*\s-o\s*\S+\s*&&\s*(\.\/|sh\b|bash\b)|\bnpx\s+(?!-)\S+@(?!\d)/i },
  { rule: 6, says: "touches credentials", hit: /(^|[\s"'=/])\.env\b|~\/\.ssh\b|\bid_[re]sa\b|\.aws\/credentials\b|\.netrc\b|\bsecurity\s+\S*-password\b|\bkeychain\b|\bCookies\b|\.config\/gh\/hosts/i },
  { rule: 7, says: "changes the machine", hit: /(^|[\s|;&(])sudo\b|\blaunchctl\b|\bcrontab\b|\bdefaults\s+write\b|\bcsrutil\b|\bspctl\b|\bsystemsetup\b|\bscutil\b|>>?\s*~?\/?(\.\w+\/)*\.(zshrc|bashrc|bash_profile|zprofile|profile)\b/i },
  { rule: 8, says: "kills processes it did not start", hit: /\b(killall|pkill)\b|\bkill\s+-9\b|\b(systemctl|service)\s+(stop|disable)\b|\bdocker\s+(kill|stop|rm)\b/i },
  { rule: 9, says: "cannot be read plainly", hit: /(^|[\s|;&(])eval\b|\bbase64\s+(-d|-D|--decode)\b|\bopenssl\s+enc\b[^|;&]*-d\b/i },
];

export function screen(request: VerifierRequest): Verdict {
  const text = request.detail || request.summary || "";
  for (const guard of guards) {
    if (guard.hit.test(text)) {
      return { allow: false, reason: clamp(`This ${guard.says}. Prohibited: ${PROHIBITED[guard.rule]}`, MAX_REASON_CHARS) };
    }
  }
  return { allow: true, reason: "Nothing on the prohibited list appears in this command." };
}

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string | ContentPart[] };

export async function review(request: VerifierRequest): Promise<VerifierReview> {
  const verdict = screen(request);
  return { model: "prohibited-list", prompt: verifierPrompt(request), reply: verdict.reason, verdict, attempts: 1 };
}

export async function chatCompletion(
  settings: VerifierSettings,
  messages: ChatMessage[],
  key: string,
  { maxTokens, timeoutMs, label, onUsage }: { maxTokens: number; timeoutMs: number; label: string; onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void },
): Promise<string> {
  const [primary, ...rest] = settings.model.split(",").map((id) => id.trim()).filter(Boolean);
  const response = await fetch(settings.endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ model: primary ?? settings.model, ...(rest.length ? { models: [primary, ...rest] } : {}), messages, temperature: 0, max_tokens: maxTokens, stream: false }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`The ${label} endpoint answered ${response.status}.`);
  const body = await response.json() as { choices?: { message?: { content?: unknown } }[]; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } };
  const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
  onUsage?.({ inputTokens: count(body.usage?.prompt_tokens), outputTokens: count(body.usage?.completion_tokens) });
  const content = body.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : "";
}
