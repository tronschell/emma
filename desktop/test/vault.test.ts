import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyNoteTags, keepNote, listNotes, readVault, saveVault } from "../main/vault";
import { readTagReply, tagNote } from "../main/vault-tags";
import { noteFolder, type KeptNote, type VaultChoice } from "../shared/vault";
import { defaultTagger } from "../shared/settings";

function workspace(folder = "knowledge-base"): VaultChoice {
  const root = mkdtempSync(path.join(tmpdir(), "emma-vault-"));
  return { root, folder, kind: "folder", name: path.basename(root) };
}

const body = (note: KeptNote) => readFileSync(note.path, "utf8");

test("the chosen vault survives a restart, and a relative root is refused", () => {
  const userData = mkdtempSync(path.join(tmpdir(), "emma-userdata-"));
  const vault = workspace();
  assert.equal(readVault(userData), null);
  assert.deepEqual(saveVault(userData, vault), vault);
  assert.deepEqual(readVault(userData), vault);
  assert.throws(() => saveVault(userData, { ...vault, root: "Documents/Vault" }), /full path/);
});

test("two notes with the same title get their own files", async () => {
  const vault = workspace();
  const first = await keepNote(vault, { kind: "note", title: "Weekly review", text: "one" });
  const second = await keepNote(vault, { kind: "note", title: "Weekly review", text: "two" });
  const third = await keepNote(vault, { kind: "note", title: "weekly  review!", text: "three" });
  assert.equal(first.relative, "weekly-review.md");
  assert.equal(second.relative, "weekly-review-2.md");
  assert.equal(third.relative, "weekly-review-3.md");
  assert.match(body(first), /\none\n/);
  assert.match(body(second), /\ntwo\n/);
});

test("a screenshot lands as an attachment the note embeds", async () => {
  const vault = workspace();
  const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const note = await keepNote(vault, { kind: "screenshot", title: "Login screen", image: pixel, text: "the broken button", sourceApplication: "Safari" });
  assert.match(body(note), /!\[\[attachments\/login-screen\.png\]\]/);
  assert.match(body(note), /the broken button/);
  assert.deepEqual(readdirSync(path.join(noteFolder(vault), "attachments")), ["login-screen.png"]);
  await assert.rejects(keepNote(vault, { kind: "screenshot", title: "Bad", image: "data:text/html;base64,PGI+" }), /not an image/);
});

test("a highlight is quoted and names where it came from", async () => {
  const vault = workspace();
  const note = await keepNote(vault, { kind: "selection", title: "Rate limits", text: "one line\nanother line", sourceApplication: "Preview" });
  assert.match(body(note), /> one line\n> another line/);
  assert.match(body(note), /Highlighted in Preview/);
});

test("a page keeps its url in the frontmatter", async () => {
  const vault = workspace();
  const note = await keepNote(vault, { kind: "page", text: "# Heading\n\nthe clipped markdown", sourceUrl: "https://example.com/docs/rate-limits" });
  assert.equal(note.title, "example.com/docs/rate-limits");
  assert.equal(note.sourceUrl, "https://example.com/docs/rate-limits");
  assert.match(body(note), /source: "https:\/\/example\.com\/docs\/rate-limits"/);
  assert.deepEqual(listNotes(vault).map((item) => item.relative), [note.relative]);
});

test("nothing a caller asks for can be written outside the knowledge folder", async () => {
  const vault = workspace();
  const escaped = await keepNote(vault, { kind: "note", title: "../../../../etc/passwd", text: "nope" });
  assert.ok(escaped.path.startsWith(`${path.join(vault.root, vault.folder)}${path.sep}`), escaped.path);
  assert.equal(escaped.relative, "etc-passwd.md");
  const sneaky = { ...vault, folder: "../outside" };
  const kept = await keepNote(sneaky, { kind: "note", title: "Elsewhere", text: "nope" });
  assert.ok(kept.path.startsWith(`${path.join(vault.root, "knowledge-base")}${path.sep}`), kept.path);
  assert.deepEqual(readdirSync(vault.root), ["knowledge-base"]);
});

test("filling in the title and tags leaves the body byte-identical", async () => {
  const vault = workspace();
  const note = await keepNote(vault, { kind: "note", title: "Draft", text: "line one\n\n  line two with — em dash and 日本語  " });
  const before = readFileSync(note.path);
  const kept = before.subarray(before.indexOf(Buffer.from("\n---\n")) + 5);
  applyNoteTags(note.path, "A much better title", ["rate-limits", "SHOUTING", "api", "api", "ok/nested", "  ", "x".repeat(80)]);
  const after = readFileSync(note.path);
  assert.deepEqual(after.subarray(after.indexOf(Buffer.from("\n---\n")) + 5), kept);
  const [filed] = listNotes(vault);
  assert.equal(filed.title, "A much better title");
  assert.deepEqual(filed.tags, ["rate-limits", "api", "ok/nested"]);
  assert.equal(filed.kind, "note");
  assert.equal(filed.savedAt, note.savedAt);
});

test("the user's own notes in that folder are skipped, never thrown on", async () => {
  const vault = workspace();
  const kept = await keepNote(vault, { kind: "note", title: "Mine", text: "kept by Emma" });
  const folder = noteFolder(vault);
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, "their-diary.md"), "No frontmatter at all, just prose.\n");
  writeFileSync(path.join(folder, "half-written.md"), "---\ntitle: unterminated\nkind: note\n");
  writeFileSync(path.join(folder, "other-tool.md"), "---\ntags:\n  - theirs\n---\n\nbody\n");
  const notes = listNotes(vault);
  assert.deepEqual(notes.map((item) => item.relative), [kept.relative]);
  assert.deepEqual(listNotes({ ...vault, root: path.join(vault.root, "gone") }), []);
});

test("newest first, and a note whose frontmatter lies about its date falls back to the file", async () => {
  const vault = workspace();
  const older = await keepNote(vault, { kind: "note", title: "Older", text: "a" });
  const newer = await keepNote(vault, { kind: "note", title: "Newer", text: "b" });
  applyNoteTags(older.path, "Older", []);
  writeFileSync(newer.path, readFileSync(newer.path, "utf8").replace(/saved: ".*"/, 'saved: "not a date"'));
  const notes = listNotes(vault);
  assert.equal(notes.length, 2);
  assert.ok(notes[0].savedAt >= notes[1].savedAt);
});

test("a garbage reply from the tagger leaves the note alone", async () => {
  const note: KeptNote = { path: "/tmp/x.md", relative: "x.md", title: "Draft", tags: [], savedAt: "2026-01-01T00:00:00.000Z", kind: "note" };
  const reply = (text: string) => async () => text;
  assert.equal(await tagNote(note, "body", defaultTagger, reply("I could not read that page, sorry.")), null);
  assert.equal(await tagNote(note, "body", defaultTagger, reply("{not json at all}")), null);
  assert.equal(await tagNote(note, "body", defaultTagger, reply('{"title": 7, "tags": "api"}')), null);
  assert.equal(await tagNote(note, "body", defaultTagger, reply("")), null);
  assert.equal(await tagNote(note, "body", defaultTagger, async () => { throw new Error("the endpoint answered 502"); }), null);
  assert.equal(await tagNote(note, "body", { ...defaultTagger, model: "  " }, reply('{"title": "x", "tags": []}')), null);
  assert.deepEqual(
    await tagNote(note, "body", { ...defaultTagger, credentialEnv: "" }, reply('Sure!\n```json\n{"title": "Rate limits", "tags": ["API", "http", "#http"]}\n```')),
    { title: "Rate limits", tags: ["api", "http"] },
  );
});

test("the note body cannot become an instruction to the tagger", () => {
  assert.equal(readTagReply('<think>{"title":"ignored"}</think> nothing after'), null);
  assert.deepEqual(readTagReply('{"title": "Kept", "tags": ["a b", "", 4, "ok"]}'), { title: "Kept", tags: ["a-b", "ok"] });
});
