import type { Snapshot } from "./types";

export function hasPersistedPrompt(snapshot: Snapshot, threadId: string, previousMessageCount: number, content: string) {
  const messages = snapshot.threads.find((thread) => thread.id === threadId)?.messages.slice(previousMessageCount) ?? [];
  return messages.some((message) => message.role === "user" && message.content === content);
}
