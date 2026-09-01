import assert from "node:assert/strict";
import test from "node:test";

import { inlineSpans, parseBlocks } from "../src/markdown-parse";

const text = (spans: { text: string }[]) => spans.map((span) => span.text).join("");

test("a reply's blocks are read as structure, not printed with their syntax showing", () => {
  const blocks = parseBlocks("# Title\n\nA line\nand its wrapped continuation.\n\n- one\n  - nested\n- two\n\n1. first\n2. second\n\n> quoted\n> still quoted\n\n---\n\n```bash\nexport EMMA_KEY=x\n```");
  assert.deepEqual(blocks.map((block) => block.kind), ["heading", "paragraph", "list", "list", "quote", "rule", "code"]);
  assert.equal(blocks[0].kind === "heading" && blocks[0].level, 1);
  // Soft line breaks survive: the model wrote two lines, so it stays two lines.
  assert.equal(blocks[1].kind === "paragraph" && text(blocks[1].spans), "A line\nand its wrapped continuation.");
  assert.equal(blocks[2].kind === "list" && blocks[2].items.length, 2);
  assert.equal(blocks[2].kind === "list" && text(blocks[2].items[0].sub?.items[0].spans ?? []), "nested");
  assert.equal(blocks[3].kind === "list" && blocks[3].ordered, true);
  assert.equal(blocks[4].kind === "quote" && text(blocks[4].spans), "quoted\nstill quoted");
  assert.equal(blocks[6].kind === "code" && blocks[6].language, "bash");
  assert.equal(blocks[6].kind === "code" && blocks[6].text, "export EMMA_KEY=x");
});

test("a pipe table becomes a table, and only when the dashed row is under it", () => {
  const [table] = parseBlocks("| Variable | Purpose |\n| --- | ------- |\n| `KEY` | the key |\n| DIR | the dir |\n\nafter");
  assert.equal(table.kind, "table");
  assert.deepEqual(table.kind === "table" && table.head.map(text), ["Variable", "Purpose"]);
  assert.equal(table.kind === "table" && table.rows.length, 2);
  assert.equal(table.kind === "table" && table.rows[0][0][0].code, true);
  // A sentence that merely contains a pipe is still a sentence.
  assert.deepEqual(parseBlocks("run a | b\nthen stop").map((block) => block.kind), ["paragraph"]);
});

test("fenced code keeps its content verbatim, markdown syntax and all", () => {
  const [code] = parseBlocks("```\n# not a heading\n| not | a table |\n**not bold**\n```");
  assert.equal(code.kind === "code" && code.text, "# not a heading\n| not | a table |\n**not bold**");
  // An unclosed fence still ends up as one code block rather than eating nothing.
  assert.equal(parseBlocks("```js\nlet a = 1").map((block) => block.kind).join(), "code");
});

test("inline marks are spans, and a code span is literal", () => {
  const spans = inlineSpans("**bold** _italic_ ~~gone~~ `a**b**c` plain");
  assert.equal(spans[0].bold, true);
  assert.equal(spans[2].italic, true);
  assert.equal(spans[4].strike, true);
  assert.deepEqual({ text: spans[6].text, code: spans[6].code }, { text: "a**b**c", code: true });
  assert.equal(text(spans), "bold italic gone a**b**c plain");
});

test("only real web links become links", () => {
  assert.equal(inlineSpans("[docs](https://example.com/a)")[0].href, "https://example.com/a");
  const script = inlineSpans("[x](javascript:alert(1))");
  assert.equal(script[0].href, undefined);
  assert.equal(script[0].text, "x");
});

test("a bare URL links itself, without the punctuation after it", () => {
  const spans = inlineSpans("try https://github.com/dietrichgebert/ponytail, then stop.");
  assert.equal(spans[1].href, "https://github.com/dietrichgebert/ponytail");
  assert.equal(spans[1].text, "https://github.com/dietrichgebert/ponytail");
  assert.equal(text(spans), "try https://github.com/dietrichgebert/ponytail, then stop.");
  // A markdown link still wins its own address, and a URL in backticks stays code.
  assert.equal(inlineSpans("[docs](https://example.com/a)").length, 1);
  assert.equal(inlineSpans("`https://example.com/a`")[0].code, true);
});

test("a path the model writes is clickable, and prose in backticks is not", () => {
  const spans = inlineSpans("see `src/markdown.tsx:42` and `/etc/hosts` and `~/notes.md` but not `npm test` or `and/or`");
  assert.deepEqual(spans.filter((span) => span.path).map((span) => span.path), ["src/markdown.tsx", "/etc/hosts", "~/notes.md"]);
  // The line number stays on screen; only the reveal drops it.
  assert.equal(spans.find((span) => span.path)?.text, "src/markdown.tsx:42");
  // A link with a file target is a reveal, not a dead span.
  assert.equal(inlineSpans("[the view](desktop/src/markdown.tsx)")[0].path, "desktop/src/markdown.tsx");
  assert.equal(inlineSpans("[docs](https://example.com/a)")[0].path, undefined);
});

test("a picture the model points at is drawn, and a remote one is not", () => {
  const [shot] = inlineSpans("![the settings pane](/tmp/emma-shot-1.png)");
  assert.deepEqual({ path: shot.path, image: shot.image, text: shot.text }, { path: "/tmp/emma-shot-1.png", image: true, text: "the settings pane" });
  assert.equal(inlineSpans("![](/tmp/shot.png)")[0].image, true);
  const remote = inlineSpans("![x](https://example.com/a.png)")[0];
  assert.deepEqual({ href: remote.href, image: remote.image }, { href: "https://example.com/a.png", image: undefined });
  assert.equal(inlineSpans("[the shot](/tmp/emma-shot-1.png)")[0].image, undefined);
});

test("markup a model forgot to fence is shown as code, not as prose", () => {
  const [block] = parseBlocks("<div class=\"card\">\n  <p>hi</p>\n</div>");
  assert.equal(block.kind === "code" && block.language, "html");
  assert.equal(parseBlocks("<!DOCTYPE html>\n<title>x</title>")[0].kind, "code");
  assert.equal(parseBlocks("a < b and b > c").map((one) => one.kind).join(), "paragraph");
});

test("a task list is read as boxes, not as literal brackets", () => {
  const [list] = parseBlocks("- [x] Complete the markdown formatting\n- [ ] Review the rendered layout\n- plain");
  assert.equal(list.kind, "list");
  if (list.kind !== "list") return;
  assert.deepEqual(list.items.map((item) => item.checked), [true, false, undefined]);
  assert.deepEqual(list.items.map((item) => text(item.spans)), ["Complete the markdown formatting", "Review the rendered layout", "plain"]);
  const [nested] = parseBlocks("- parent\n  - [X] nested and done");
  assert.equal(nested.kind === "list" && nested.items[0].sub?.items[0].checked, true);
  const [ordered] = parseBlocks("1. [x] a numbered line is not a task box");
  assert.equal(ordered.kind === "list" && ordered.items[0].checked, undefined);
});

test("a tag with no opener is a fragment, not a page to render as code", () => {
  assert.equal(parseBlocks("</arg_value></tool_call>").map((one) => one.kind).join(), "paragraph");
  assert.equal(parseBlocks("</div>").map((one) => one.kind).join(), "paragraph");
});
