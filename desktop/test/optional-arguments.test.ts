import assert from "node:assert/strict";
import test from "node:test";
import { parseToolArgs } from "../main/tools";

test("empty optional tool strings are omitted", () => {
  assert.deepEqual(parseToolArgs("artifact", JSON.stringify({
    action: "create",
    id: "",
    file: "",
    title: "Live UI Demo",
    kind: "code",
    language: "js",
    surface: "context",
    content: "export default () => () => null",
    old_str: "",
    new_str: "",
  })), {
    name: "artifact",
    action: "create",
    id: undefined,
    file: undefined,
    title: "Live UI Demo",
    kind: "code",
    language: "js",
    surface: "context",
    content: "export default () => () => null",
    oldStr: undefined,
    newStr: "",
  });
});
