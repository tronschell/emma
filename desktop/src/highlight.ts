/* Syntax highlighting for a fenced block, as one language-agnostic tokenizer
   rather than a grammar per language: comments, strings, numbers, tags,
   attribute/property names and a keyword union that covers what a model
   actually writes here (TS/JSX, HTML, CSS, Rust, Zig, Python, shell).

   Plain .ts, not .tsx, for the same reason markdown-parse.ts is (the test
   compile does not take JSX), and it returns data — markdown.tsx turns tokens
   into elements, so nothing here can produce markup.

   ponytail: no highlight.js, no shiki. A real grammar buys per-language
   correctness at ~1MB and a build step; swap this out if a language ever needs
   to be right rather than readable. */

export type TokenKind = "comment" | "string" | "number" | "keyword" | "tag" | "attr";
export interface Token { text: string; kind?: TokenKind }

const KEYWORDS = new Set(`
and as async await break case catch class const constructor continue declare def default defer delete do
elif else enum export extends extern false final finally fn for from func function global go if impl implements
import in include inline interface is lambda let loop match mod module move mut new nil none not null nullptr
or override package pass private protected pub public raise readonly return self static struct super switch
template then this throw trait true try type typedef typeof undefined union unsafe use using var void when
where while with yield
`.trim().split(/\s+/));

/** Languages where `#` starts a comment. Everywhere else it is a colour or an id. */
const HASH = /^(sh|bash|zsh|shell|console|fish|py|python|rb|ruby|pl|perl|r|ya?ml|toml|ini|conf|cfg|env|make(file)?|dockerfile|nix|gitignore)$/i;

/* One alternation, tried left to right at each position: a comment first (so a
   `//` inside a string never wins, and a `"` inside a comment never does
   either), then strings, tags, numbers, and finally a bare name. */
const CORE = String.raw`\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->|\/\/[^\n]*)|("(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|\x60(?:\\.|[^\x60\\])*\x60?)|(<\/?[A-Za-z][\w.:-]*)|(\b\d[\w.]*)|([A-Za-z_$@#-][\w$-]*)`;

/**
 * The block's text split into runs. Every character of the input comes back
 * exactly once, in order, so rendering the tokens rebuilds the block verbatim.
 */
export function tokenize(text: string, language = ""): Token[] {
  const pattern = new RegExp(`(${HASH.test(language) ? String.raw`#[^\n]*|` : ""}${CORE}`, "g");
  const tokens: Token[] = [];
  let last = 0;
  const plain = (end: number) => { if (end > last) tokens.push({ text: text.slice(last, end) }); };

  for (const match of text.matchAll(pattern)) {
    const [whole, comment, string, tag, number, word] = match;
    plain(match.index);
    last = match.index + whole.length;
    if (comment) tokens.push({ text: whole, kind: "comment" });
    else if (string) tokens.push({ text: whole, kind: "string" });
    else if (tag) tokens.push({ text: whole, kind: "tag" });
    else if (number) tokens.push({ text: whole, kind: "number" });
    else if (KEYWORDS.has(word)) tokens.push({ text: whole, kind: "keyword" });
    // An HTML attribute, a CSS property and a JSON key are all "a name with a
    // separator tight behind it", so one lookahead catches the three of them.
    // Tight matters: `a = 1` is an assignment, `a=1` in a tag is an attribute.
    else if (/^[:=](?!=)/.test(text.slice(last))) tokens.push({ text: whole, kind: "attr" });
    else tokens.push({ text: whole });
  }
  plain(text.length);
  return tokens;
}
