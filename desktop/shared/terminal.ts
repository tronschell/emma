export type TerminalTab = {
  id: string;
  threadId: string;
  title: string;
  cwd: string;
  running: boolean;
  exitCode: number | null;
};

export const MAX_TERMINAL_TABS = 8;
export const MAX_TERMINAL_SCROLLBACK = 256 * 1024;
export const MAX_TERMINAL_INPUT = 64 * 1024;
export const MAX_TERMINAL_COLUMNS = 4096;
export const MAX_TERMINAL_SELECTION_LINES = 200;
export const MAX_TERMINAL_SELECTION_CHARS = 16 * 1024;

export const DEFAULT_TERMINAL_HEIGHT = 260;
export const MIN_TERMINAL_HEIGHT = 120;
export const MAX_TERMINAL_HEIGHT = 720;

export function terminalTitle(cwd: string): string {
  const name = cwd.replace(/\/+$/, "").split("/").pop();
  return name && name.length <= 40 ? name : "shell";
}

export function terminalSelection(raw: string): { text: string; lines: number } | null {
  const lines = raw.replace(/\r/g, "").split("\n").map((line) => line.replace(/[ \t]+$/, ""));
  while (lines.length && !lines[0]!.trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  if (!lines.length) return null;
  const kept = lines.slice(0, MAX_TERMINAL_SELECTION_LINES);
  let text = kept.join("\n");
  if (text.length > MAX_TERMINAL_SELECTION_CHARS) text = text.slice(0, MAX_TERMINAL_SELECTION_CHARS);
  const dropped = lines.length - kept.length;
  return { text: dropped ? `${text}\n[${dropped} more lines not attached]` : text, lines: lines.length };
}
