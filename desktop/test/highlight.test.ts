import assert from "node:assert/strict";
import test from "node:test";

import { tokenize } from "../src/highlight";

const kinds = (text: string, language?: string) =>
  tokenize(text, language).filter((token) => token.kind).map((token) => `${token.kind}:${token.text}`);

test("highlighting never loses or reorders a character", () => {
  const source = "const a = \"x // y\"; // trailing\n<div id=\"z\">1.5</div>\n";
  assert.equal(tokenize(source, "tsx").map((token) => token.text).join(""), source);
  assert.deepEqual(kinds(source, "tsx"), ["keyword:const", "string:\"x // y\"", "comment:// trailing", "tag:<div", "attr:id", "string:\"z\"", "number:1.5", "tag:</div"]);
});

test("a hash is a comment only where the language says so", () => {
  assert.deepEqual(kinds("# note\nrm -rf x", "bash"), ["comment:# note"]);
  assert.deepEqual(kinds("a { color: #fff; }", "css"), ["attr:color"]);
});
