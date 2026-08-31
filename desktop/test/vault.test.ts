import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyNoteTags, createNoteFolder, keepNote, listNoteFolders, listNotes, moveNote, readVault, renameNoteFolder, saveVault } from "../main/vault";
import { readTagReply, tagNote } from "../main/vault-tags";
import { noteFolder, type KeptNote, type VaultChoice } from "../shared/vault";
import { defaultTagger } from "../shared/settings";

function workspace(folder = "knowledge-base"): VaultChoice {
  const root = mkdtempSync(path.join(tmpdir(), "emma-vault-"));
  return { root, folder, kind: "folder", name: path.basename(root) };
}

const body = (note: KeptNote) => readFileSync(note.path, "utf8");

const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

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

test("a card reads its own excerpt and picture out of the note, and refuses a picture outside the vault", async () => {
  const vault = workspace();
  const shot = await keepNote(vault, { kind: "screenshot", title: "Login", text: "The focus ring is gone", image: PIXEL });
  const quote = await keepNote(vault, { kind: "selection", title: "Masonry", text: "Columns get you\nmost of the way" });
  const folder = noteFolder(vault);
  writeFileSync(path.join(folder, "escaped.md"), '---\ntitle: "Escaped"\nkind: "note"\nsaved: "2026-01-01T00:00:00.000Z"\n---\n\n![[../../etc/passwd.png]]\n![](https://example.com/remote.png)\n\nbody text\n');
  const notes = listNotes(vault);
  const found = (relative: string) => notes.find((note) => note.relative === relative)!;
  assert.equal(found(shot.relative).excerpt, "The focus ring is gone");
  assert.equal(found(shot.relative).image, path.join(folder, "attachments", shot.relative.replace(/\.md$/, ".png")));
  assert.equal(found(quote.relative).excerpt, "Columns get you most of the way");
  assert.equal(found("escaped.md").image, undefined);
  assert.equal(found("escaped.md").excerpt, "body text");
});

test("a folder is a directory, and a save filed into it keeps its picture and comes back under that folder", async () => {
  const vault = workspace();
  const shot = await keepNote(vault, { kind: "screenshot", title: "Login", text: "focus ring", image: PIXEL });
  const made = createNoteFolder(vault, "  Design  ");
  assert.equal(made.name, "Design");
  assert.deepEqual(listNoteFolders(vault).map((folder) => folder.name), ["Design"]);
  assert.equal(moveNote(vault, shot.relative, "Design"), path.join("Design", shot.relative));
  const notes = listNotes(vault);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].folder, "Design");
  assert.equal(notes[0].image, path.join(noteFolder(vault), "attachments", shot.relative.replace(/\.md$/, ".png")));
  assert.equal(moveNote(vault, notes[0].relative, ""), shot.relative);
  assert.equal(listNotes(vault)[0].folder, undefined);
});

test("renaming a folder carries its saves and refuses a name that escapes or collides", async () => {
  const vault = workspace();
  const note = await keepNote(vault, { kind: "note", title: "Kept", text: "body" });
  createNoteFolder(vault, "Design");
  createNoteFolder(vault, "Taken");
  moveNote(vault, note.relative, "Design");
  assert.equal(renameNoteFolder(vault, "Design", "  Sketches  ").name, "Sketches");
  assert.deepEqual(listNoteFolders(vault).map((folder) => folder.name), ["Sketches", "Taken"]);
  assert.equal(listNotes(vault)[0].folder, "Sketches");
  for (const name of ["../escape", "nested/deep", "attachments", "", "  ", "Taken"]) {
    assert.throws(() => renameNoteFolder(vault, "Sketches", name), Error, `accepted ${JSON.stringify(name)}`);
  }
  assert.throws(() => renameNoteFolder(vault, "Missing", "Sketches"), Error);
});

test("a folder name that would escape the vault, collide, or hide the attachments is refused", async () => {
  const vault = workspace();
  const note = await keepNote(vault, { kind: "note", title: "Kept", text: "body" });
  createNoteFolder(vault, "Design");
  for (const name of ["../escape", "nested/deep", "attachments", ".hidden", "", "  ", "Design"]) {
    assert.throws(() => createNoteFolder(vault, name), Error, `accepted ${JSON.stringify(name)}`);
  }
  assert.throws(() => moveNote(vault, note.relative, "../escape"));
  assert.throws(() => moveNote(vault, note.relative, "Missing"));
  assert.deepEqual(listNoteFolders(vault).map((folder) => folder.name), ["Design"]);
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
