import { WEB_SEARCH_PROVIDERS, type WebSearchProvider } from "../shared/settings";
import type { ThreadStep } from "../shared/agents";

export function searchProvider(step: Pick<ThreadStep, "toolName" | "kind" | "input" | "output">): WebSearchProvider | undefined {
  if (step.toolName !== "web_search" && (step.toolName || step.kind !== "search")) return undefined;
  if (!step.input || !step.output) return undefined;
  try {
    const query: unknown = JSON.parse(step.input)?.query;
    if (typeof query !== "string") return undefined;
    const prefix = [`Results for ${query}. `, `No results for ${query}.\n\n`].find((value) => step.output!.startsWith(value));
    if (!prefix) return undefined;
    const provider = /^Provider: ([^.,\n]+)[.,]/.exec(step.output.slice(prefix.length))?.[1];
    return WEB_SEARCH_PROVIDERS.find((item) => item.label === provider)?.id;
  } catch {
    return undefined;
  }
}
