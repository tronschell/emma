import assert from "node:assert/strict";
import test from "node:test";

import { documentGroups, inlineSpans, parseMarkdown } from "../src/document";
import type { ArtifactBlock } from "../src/types";

const block = (id: string, type: string): ArtifactBlock => ({ id, type, version: 1, source: {}, payload: {}, fallback: "" });

test("markdown becomes structure instead of printed syntax", () => {
  const nodes = parseMarkdown("## Why it matters\n\nA claim with **weight**.\nSame paragraph.\n\n- first\n- second\n\n1. step one\n\n> quoted\n\n```\ncode\n```");
  assert.deepEqual(nodes.map((node) => node.kind), ["heading", "paragraph", "list", "list", "quote", "code"]);
  assert.equal(nodes[0].kind === "heading" && nodes[0].level, 2);
  // Wrapped lines join into one paragraph rather than breaking mid-sentence.
  assert.equal(nodes[1].kind === "paragraph" && nodes[1].spans.map((span) => span.text).join(""), "A claim with weight. Same paragraph.");
  assert.equal(nodes[1].kind === "paragraph" && nodes[1].spans[1].bold, true);
  assert.equal(nodes[2].kind === "list" && nodes[2].items.length, 2);
  assert.equal(nodes[3].kind === "list" && nodes[3].ordered, true);
  assert.equal(nodes[5].kind === "code" && nodes[5].text, "code");
});

test("only real web links become links", () => {
  const [web, script] = [inlineSpans("[docs](https://example.com/a)"), inlineSpans("[x](javascript:alert(1))")];
  assert.equal(web[0].href, "https://example.com/a");
  assert.equal(script[0].href, undefined);
  assert.equal(script[0].text, "x");
});

test("neighbouring pictures become one carousel and the lede is not repeated", () => {
  const groups = documentGroups([block("summary", "rich-text"), block("a", "image"), block("b", "image"), block("prose", "rich-text"), block("c", "image")]);
  assert.deepEqual(groups.map((group) => group.kind), ["images", "block", "images"]);
  assert.equal(groups[0].kind === "images" && groups[0].blocks.length, 2);
});

test("underscores inside an identifier are not emphasis", () => {
  assert.deepEqual(inlineSpans('"cls_token":"[CLS]"'), [{ text: '"cls_token":"[CLS]"' }]);
  assert.deepEqual(inlineSpans("_really_ though"), [{ text: "really", italic: true }, { text: " though" }]);
});
