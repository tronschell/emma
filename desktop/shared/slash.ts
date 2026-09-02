/* The composer's "/" commands and "@" file mentions: the menu that opens while a
   name is being typed, and the coloured tokens it leaves behind in the message.
   One grammar, two sigils — "/" names a capability, "@" names a file by its
   folder-relative path. Pure text work only — the renderer owns the popover and
   the mirrored highlight layer. */

import type { ContextPick } from "./folders";

export type SlashKind = "tool" | "skill" | "mcp" | "builtin" | "file" | "category" | "artifact" | "page" | "terminal" | "diff" | "visual" | "component";
export interface SlashCommand {
  id: string;
  name: string;
  kind: SlashKind;
  detail: string;
  /** Present on the local-context kinds: what picking this attaches to the next turn. */
  pick?: ContextPick;
}

/** The word every menu row wears, so a built-in tool never reads as an imported
    skill and a knowledge page never reads as a file on disk. */
export const KIND_LABELS: Record<SlashKind, string> = {
  tool: "Tool",
  skill: "Skill",
  mcp: "MCP",
  builtin: "Built-in",
  file: "File",
  category: "Category",
  artifact: "Artifact",
  page: "Knowledge",
  terminal: "Terminal",
  diff: "Diff",
  visual: "Picture",
  component: "Built by Emma",
};

/** Hues a "/" token cycles through. Orange is the accent and stays out of it. */
export const SLASH_HUES = 5;
/** The one hue past the rotation, reserved for every "@" file mention. */
export const FILE_HUE = SLASH_HUES;
/** And the one past that, for a pasted link. */
export const LINK_HUE = FILE_HUE + 1;
/** Rows a menu draws: a connected folder can list hundreds of files.
    ponytail: a flat cap, not virtualisation — narrow the query instead. */
export const MENU_MAX = 20;

/** The names the composer answers itself, before any import is consulted. */
export const BUILTIN_COMMANDS: SlashCommand[] = [
  { id: "agent", name: "agent", kind: "builtin", detail: "built-in · Zig coding harness" },
  { id: "council", name: "council", kind: "builtin", detail: "built-in · seat several models on one question" },
  { id: "import", name: "import", kind: "builtin", detail: "built-in · import skills & MCP" },
  { id: "new", name: "new", kind: "builtin", detail: "built-in · new thread in this project" },
  { id: "clear", name: "clear", kind: "builtin", detail: "built-in · empty the context window" },
];

export type Sigil = "/" | "@";

/* A "/" name is one word: the token ends at whitespace or a second slash. An "@"
   name is a path, so it keeps its slashes and ends only at whitespace. */
const NAME = "[A-Za-z0-9][A-Za-z0-9._:-]*";
const PATH = "[A-Za-z0-9][A-Za-z0-9._:/-]*";
const GRAMMAR: [Sigil, string][] = [["/", NAME], ["@", PATH]];
const TYPING = GRAMMAR.map(([sigil, name]) => [sigil, new RegExp(`(?:^|\\s)[${sigil}](${name}|)$`)] as const);
/* A link ends before the punctuation a sentence puts after it, so "see https://a.dev." keeps its full stop as prose. */
const LINK = "https?://[^\\s<>()\\[\\]]*[^\\s<>()\\[\\].,;:!?'\"]";
const TOKEN = new RegExp(`(^|\\s)(${LINK}|/${NAME}|@${PATH})`, "g");

/** Turn a file path into an "@" name: the path, in the grammar's alphabet. */
export function pathName(path: string): string {
  const name = path.replace(/[^A-Za-z0-9._:/-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "");
  return name || "file";
}

/** The "/name" or "@path" fragment under the caret, or null when the caret is in
    neither. A sigil only opens at a word start, so "a/b" and "me@host" stay prose,
    and since the caret sits in at most one fragment only one menu can ever open. */
export function slashQuery(text: string, caret: number) {
  const head = text.slice(0, Math.max(0, caret));
  for (const [sigil, pattern] of TYPING) {
    const match = pattern.exec(head);
    if (match) return { start: caret - match[1].length - 1, query: match[1], sigil };
  }
  return null;
}

/* Tab completes whatever lands first, so what a name starts with outranks what
   it merely contains: "/gen" has to reach "general" before "agent". */
export function matchCommands(commands: SlashCommand[], query: string) {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...commands];
  const rank = (command: SlashCommand) => (command.name.toLocaleLowerCase().startsWith(needle) ? 0 : 1);
  return commands
    .filter((command) => command.name.toLocaleLowerCase().includes(needle))
    .map((command, index) => ({ command, index }))
    .sort((left, right) => rank(left.command) - rank(right.command) || left.index - right.index)
    .map((entry) => entry.command);
}

/** Swap the fragment under the caret for the chosen name, and say where the caret lands. */
export function insertCommand(text: string, at: { start: number; query: string; sigil?: Sigil }, name: string) {
  const tail = text.slice(at.start + at.query.length + 1);
  const head = `${text.slice(0, at.start)}${at.sigil ?? "/"}${name}${/^\s/.test(tail) ? "" : " "}`;
  return { text: head + tail, caret: head.length };
}

/** Every "/name" or "@path" written in a message. The composer resolves these as
    they are typed; an unattended run has only the saved text, so it reads them back. */
export function mentions(text: string, sigil: Sigil): string[] {
  return [...text.matchAll(TOKEN)].map((match) => match[2]).filter((token) => token.startsWith(sigil)).map((token) => token.slice(1));
}

export interface SlashSegment {
  text: string;
  /** Absent for ordinary prose; otherwise the hue index for this name. */
  hue?: number;
}

/** Split a message so each token naming a known command can be painted its own hue.
    Hues are handed out in order of first appearance, so a name keeps its colour.
    Every known "@" path instead takes FILE_HUE, so a file mention never wears a
    command's colour. */
export function highlightSegments(text: string, names: string[], paths: string[] = []): SlashSegment[] {
  const known = { "/": new Set(names.map((name) => name.toLocaleLowerCase())), "@": new Set(paths.map((path) => path.toLocaleLowerCase())) };
  const order: string[] = [];
  const segments: SlashSegment[] = [];
  let index = 0;
  for (const match of text.matchAll(TOKEN)) {
    const token = match[2];
    const sigil = token[0] as Sigil;
    const link = sigil !== "/" && sigil !== "@";
    const name = token.slice(1).toLocaleLowerCase();
    if (!link && !known[sigil].has(name)) continue;
    const start = match.index + match[1].length;
    if (start > index) segments.push({ text: text.slice(index, start) });
    if (link) segments.push({ text: token, hue: LINK_HUE });
    else if (sigil === "@") segments.push({ text: token, hue: FILE_HUE });
    else {
      if (!order.includes(name)) order.push(name);
      segments.push({ text: token, hue: order.indexOf(name) % SLASH_HUES });
    }
    index = start + token.length;
  }
  if (index < text.length) segments.push({ text: text.slice(index) });
  return segments;
}
