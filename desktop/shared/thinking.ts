/// Reasoning models put their scratchpad inline in `content` as a <think> block.
/// Nothing between the provider and the transcript strips it — not the Zig
/// sidecar, not the host — so folding it away is the renderer's job.
///
/// An unclosed block means the model is still in the scratchpad: everything is
/// thinking and there is no answer yet. That is also what a truncated reply
/// looks like, which is the honest reading of both.
/// The inverse, for a source that streams reasoning on its own channel instead of
/// inline: the coding harness sends `agent_thought_chunk` separately, and the
/// durable message is plain text, so the two are rejoined into the one shape
/// `splitThinking` already knows how to fold away.
export function withThinking(thinking: string | undefined, answer: string): string {
  const scratch = thinking?.trim();
  return scratch ? `<think>${scratch}</think>\n${answer}` : answer;
}

export function splitThinking(content: string): { thinking: string; answer: string } {
  const open = /^\s*<(think|thinking|reasoning)>/i.exec(content);
  if (!open) return { thinking: "", answer: content };
  const rest = content.slice(open[0].length);
  const close = new RegExp(`</${open[1]}\\s*>`, "i").exec(rest);
  if (!close) return { thinking: rest.trim(), answer: "" };
  return { thinking: rest.slice(0, close.index).trim(), answer: rest.slice(close.index + close[0].length).trimStart() };
}
