import test from "node:test";
import assert from "node:assert/strict";
import { FILE_HUE, highlightSegments, insertCommand, KIND_LABELS, matchCommands, mentions, pathName, slashQuery, type SlashCommand } from "../shared/slash";
import { atCommands, fileCommands, toolCommands } from "../src/context";
import { pickKey } from "../shared/folders";
import type { ArtifactMeta } from "../shared/artifacts";
import type { Snapshot } from "../src/types";

const commands: SlashCommand[] = [
  { id: "a", name: "context7", kind: "mcp", detail: "" },
  { id: "b", name: "code-review", kind: "skill", detail: "" },
];

test("a slash opens the menu anywhere a word can start, but not mid-word", () => {
  assert.deepEqual(slashQuery("/", 1), { start: 0, query: "", sigil: "/" });
  assert.deepEqual(slashQuery("run /cont", 9), { start: 4, query: "cont", sigil: "/" });
  assert.equal(slashQuery("http://host", 8), null);
  assert.equal(slashQuery("/one two", 8), null);
  assert.deepEqual(slashQuery("/one /two", 4), { start: 0, query: "one", sigil: "/" });
});

test("matching is a case-insensitive substring, and empty lists everything", () => {
  assert.deepEqual(matchCommands(commands, "").length, 2);
  assert.deepEqual(matchCommands(commands, "REVIEW").map((item) => item.name), ["code-review"]);
});

test("a name that starts with the query outranks one that merely contains it", () => {
  const listed: SlashCommand[] = [{ id: "c", name: "agent", kind: "builtin", detail: "" }, { id: "d", name: "general", kind: "skill", detail: "" }];
  assert.deepEqual(matchCommands(listed, "gen").map((item) => item.name), ["general", "agent"]);
});

test("choosing a command replaces the typed fragment and leaves the caret after it", () => {
  assert.deepEqual(insertCommand("run /cont now", { start: 4, query: "cont" }, "context7"), { text: "run /context7 now", caret: 13 });
});

test("each known name keeps one hue; unknown tokens stay prose", () => {
  const segments = highlightSegments("use /context7 and /code-review, not /nope or a/b", ["context7", "code-review"]);
  assert.deepEqual(segments.filter((item) => item.hue !== undefined), [
    { text: "/context7", hue: 0 },
    { text: "/code-review", hue: 1 },
  ]);
  assert.equal(segments.map((item) => item.text).join(""), "use /context7 and /code-review, not /nope or a/b");
  assert.deepEqual(highlightSegments("/context7 /context7", ["context7"]).map((item) => item.hue), [0, undefined, 0]);
});

/* The "@" sigil: the same grammar, but the name is a path and the menu lists files. */

test("an @ opens on a path at a word start, and never mid-word", () => {
  assert.deepEqual(slashQuery("@", 1), { start: 0, query: "", sigil: "@" });
  assert.deepEqual(slashQuery("read @src/App", 13), { start: 5, query: "src/App", sigil: "@" });
  assert.equal(slashQuery("mail me@host.com", 16), null);
  assert.deepEqual(slashQuery("/skill @doc", 6), { start: 0, query: "skill", sigil: "/" });
});

test("choosing a file writes an @path token, and matching reads the whole path", () => {
  const files = fileCommands([{ id: "f1", path: "/Users/me/Documents", name: "Documents" }], ["f1"], { f1: [{ path: "notes/road map.md", bytes: 10 }] });
  assert.deepEqual(files.map((item) => item.name), ["notes/road-map.md"]);
  assert.deepEqual(matchCommands(files, "road").map((item) => item.name), ["notes/road-map.md"]);
  assert.deepEqual(matchCommands(files, "notes").map((item) => item.name), ["notes/road-map.md"]);
  assert.deepEqual(files[0].pick, { kind: "file", folderId: "f1", path: "notes/road map.md" });
  assert.deepEqual(insertCommand("read @not", { start: 5, query: "not", sigil: "@" }, files[0].name), { text: "read @notes/road-map.md ", caret: 24 });
  assert.equal(pathName("./ odd name.txt"), "odd-name.txt");
});

test("a file mention keeps its own hue, whatever colours the commands took", () => {
  const segments = highlightSegments("/context7 on @src/App.tsx and @gone", ["context7"], ["src/App.tsx"]);
  assert.deepEqual(segments.filter((item) => item.hue !== undefined), [
    { text: "/context7", hue: 0 },
    { text: "@src/App.tsx", hue: FILE_HUE },
  ]);
  assert.equal(segments.map((item) => item.text).join(""), "/context7 on @src/App.tsx and @gone");
});

/* "/" also names a built-in tool, and "@" also names an artifact or a saved page. */

test("every built-in tool is a / command, and Settings can switch one out of the menu", () => {
  const all = toolCommands();
  assert.ok(all.length > 20, "the whole catalog lists");
  assert.ok(all.every((item) => item.kind === "tool" && !item.pick), "tools attach nothing");
  const saved = all.find((item) => item.name === "save_page");
  assert.equal(KIND_LABELS[saved!.kind], "Tool");
  // A tool name carries an underscore, which the "/" grammar has to accept.
  assert.deepEqual(matchCommands(all, "save_p").map((item) => item.name), ["save_page"]);
  assert.deepEqual(slashQuery("use /save_page", 14), { start: 4, query: "save_page", sigil: "/" });
  assert.equal(toolCommands(["save_page"]).some((item) => item.name === "save_page"), false);
});

test("@ lists what Emma made and saved before the files on disk", () => {
  const artifacts = [{ id: "a1", title: "Q3 plan", kind: "markdown", language: "", createdAt: "", updatedAt: "", version: 1 }] as ArtifactMeta[];
  const snapshot = {
    knowledgeBases: [{ id: "b1", name: "Research" }],
    pages: [{ id: "p1", knowledgeBaseId: "b1", title: "Ceramics primer", category: "materials" }],
  } as unknown as Snapshot;
  const items = atCommands(artifacts, snapshot, [{ id: "f1", path: "/Users/me/Docs", name: "Docs" }], ["f1"], { f1: [{ path: "notes/plan.md", bytes: 10 }] });
  assert.deepEqual(items.map((item) => [item.kind, item.name]), [
    ["artifact", "Q3-plan"],
    ["page", "Ceramics-primer"],
    ["file", "notes/plan.md"],
  ]);
  assert.deepEqual(items[0].pick, { kind: "artifact", id: "a1", title: "Q3 plan" });
  assert.deepEqual(items[1].pick, { kind: "page", id: "p1" });
  assert.equal(pickKey(items[1].pick!), "page:p1");
  // A shared word still ranks the artifact first, because it is listed first.
  assert.deepEqual(matchCommands(items, "plan").map((item) => item.kind), ["artifact", "file"]);
});

test("a saved message still names its skills and files, for a run to resolve later", () => {
  const text = "Use /code-review on @src/App.tsx and @notes/road-map.md, not me@host or a/b";
  assert.deepEqual(mentions(text, "/"), ["code-review"]);
  assert.deepEqual(mentions(text, "@"), ["src/App.tsx", "notes/road-map.md"]);
});
