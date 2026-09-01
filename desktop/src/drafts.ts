import type { Thread } from "./types";

export function hasPersistedPrompt(thread: Thread | undefined, previousMessageCount: number, content: string) {
  const messages = thread?.messages.slice(previousMessageCount) ?? [];
  return messages.some((message) => message.role === "user" && message.content === content);
}
