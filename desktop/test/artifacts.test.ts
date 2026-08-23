import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { artifactFiles, artifactRoot, deleteArtifact, listArtifacts, queryArtifact, readArtifact, readArtifactFile, updateArtifact, updateArtifactFile, writeArtifact, writeArtifactFile } from "../main/artifacts";
import { ARTIFACT_DB_FILE, artifactMarker, artifactWritten, MAX_ARTIFACT_BYTES, MAX_ARTIFACT_DB_BYTES, MAX_ARTIFACT_ROWS, MAX_ARTIFACT_SQL_PARAMS } from "../shared/artifacts";
import { parseToolArgs, toolDefinitions } from "../main/tools";

const userData = () => mkdtemp(path.join(tmpdir(), "emma-artifacts-"));

test("an artifact round-trips, and a rewrite keeps where it came from", async () => {
  const directory = await userData();
  try {
    const made = await writeArtifact(directory, { title: "Flight tracker", kind: "html", content: "<h1>Flights</h1>", sourceThreadId: "thread-1" });
    assert.equal(made.id, "flight-tracker");
    assert.equal(made.version, 1);
    assert.equal(made.path, path.join(artifactRoot(directory), "flight-tracker", "content.html"));
    assert.equal(await readFile(made.path, "utf8"), "<h1>Flights</h1>");

    const read = await readArtifact(directory, "flight-tracker");
    assert.deepEqual(read, made);

    // A second artifact with the same title gets its own id rather than eating the first.
    const second = await writeArtifact(directory, { title: "Flight tracker", kind: "markdown", content: "notes" });
    assert.equal(second.id, "flight-tracker-2");

    const rewritten = await writeArtifact(directory, { id: "flight-tracker", title: "Flight tracker", kind: "html", content: "<h1>Flights today</h1>" });
    assert.equal(rewritten.version, 2);
    assert.equal(rewritten.createdAt, made.createdAt, "a rewrite is the same artifact, not a new one");
    assert.equal(rewritten.sourceThreadId, "thread-1", "the thread that made it survives a rewrite that does not name one");
    assert.ok(rewritten.updatedAt >= made.updatedAt);

    assert.deepEqual((await listArtifacts(directory)).map((artifact) => artifact.id).sort(), ["flight-tracker", "flight-tracker-2"]);

    await deleteArtifact(directory, "flight-tracker-2");
    assert.deepEqual((await listArtifacts(directory)).map((artifact) => artifact.id), ["flight-tracker"]);
    await assert.rejects(readArtifact(directory, "flight-tracker-2"), /There is no artifact called "flight-tracker-2"/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a replacement that would not land is refused rather than silently skipped", async () => {
  const directory = await userData();
  try {
    await writeArtifact(directory, { id: "notes", title: "Notes", kind: "markdown", content: "one\ntwo\nsame\nsame\n" });

    const edited = await updateArtifact(directory, "notes", "two", "TWO");
    assert.equal(edited.content, "one\nTWO\nsame\nsame\n");
    assert.equal(edited.version, 2);

    // The failure this exists for: a no-op leaves the model believing the edit landed.
    await assert.rejects(updateArtifact(directory, "notes", "three", "THREE"), /No replacement was performed, old_str `three` did not appear verbatim in notes\./);
    await assert.rejects(updateArtifact(directory, "notes", "same", "x"), /Multiple occurrences of old_str `same` in lines: 3, 4\. Please ensure it is unique/);
    assert.equal((await readArtifact(directory, "notes")).content, "one\nTWO\nsame\nsame\n", "a refused edit changes nothing");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("nothing addressable escapes the artifacts folder, and a corrupt one is skipped not fatal", async () => {
  const directory = await userData();
  try {
    await writeArtifact(directory, { id: "kept", title: "Kept", kind: "markdown", content: "still here" });
    await writeFile(path.join(artifactRoot(directory), "meta.json"), "not an artifact");
    assert.deepEqual((await listArtifacts(directory)).map((artifact) => artifact.id), ["kept"]);

    for (const attempt of ["../evil", "/etc/passwd", "kept/../../evil", "Kept", "", "a".repeat(80)]) {
      await assert.rejects(readArtifact(directory, attempt), /is not an artifact id/, attempt);
      await assert.rejects(deleteArtifact(directory, attempt), /is not an artifact id/, attempt);
      await assert.rejects(writeArtifact(directory, { id: attempt, title: "Evil", kind: "markdown", content: "x" }), /is not an artifact id/, attempt);
    }

    await assert.rejects(writeArtifact(directory, { title: "Too big", kind: "markdown", content: "x".repeat(MAX_ARTIFACT_BYTES + 1) }), /larger than 512K/);
    await assert.rejects(writeArtifact(directory, { title: "", kind: "markdown", content: "x" }), /needs a title/);
    await assert.rejects(writeArtifact(directory, { title: "Wrong kind", kind: "pdf", content: "x" }), /is not an artifact kind/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/* The point of an app: close it, come back a week later, the data is still there.
   Each call here is a separate connection to the same file on disk, which is what
   reopening it is — and the file is inside the artifact's own folder, so deleting
   the artifact takes the data with it and leaves nothing to sweep up. */
test("an app's database is its own, outlives the connection, and dies with the artifact", async () => {
  const directory = await userData();
  try {
    const app = await writeArtifact(directory, { title: "Habit tracker", kind: "app", content: "<!doctype html><script>emma.sql('select 1')</script>" });
    const database = path.join(artifactRoot(directory), app.id, ARTIFACT_DB_FILE);

    await queryArtifact(directory, app.id, "create table done (day text primary key, count integer)", []);
    await queryArtifact(directory, app.id, "insert into done values (?, ?)", ["2026-08-22", 3]);
    // A week later, a new connection to the same file: the row is still in there.
    assert.deepEqual(await queryArtifact(directory, app.id, "select day, count from done", []), [{ day: "2026-08-22", count: 3 }]);
    assert.ok((await stat(database)).size > 0, "the database is a real file beside the source, not a cache");
    // Beside it, not instead of it: reading the artifact still gives the page.
    assert.match((await readArtifact(directory, app.id)).content, /^<!doctype html>/);

    // A second app is a second database. One app cannot see the other's rows.
    const other = await writeArtifact(directory, { title: "Ledger", kind: "app", content: "<!doctype html>" });
    await assert.rejects(queryArtifact(directory, other.id, "select * from done", []), /no such table: done/);

    await deleteArtifact(directory, app.id);
    assert.equal(await stat(database).catch(() => null), null, "the database goes with the folder — no orphan left behind");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/* The trust boundary. The page's script is model-written and runs in a sandboxed
   frame, so everything it can say is checked here: which artifact it is (the
   renderer's answer, never the frame's), whether that artifact may have a database
   at all, and what a statement is allowed to hand over or ask back. */
test("the sql bridge refuses everything that is not one statement against one app", async () => {
  const directory = await userData();
  try {
    const app = await writeArtifact(directory, { title: "Notes app", kind: "app", content: "<!doctype html>" });
    await writeArtifact(directory, { id: "page", title: "Page", kind: "html", content: "<h1>hi</h1>" });

    // Only an app has one. A page framed the same way must not grow a database.
    await assert.rejects(queryArtifact(directory, "page", "select 1", []), /is a html artifact, so it has no database/);
    // An id the frame could only have made up never reaches the disk.
    for (const attempt of ["../evil", "/etc/passwd", "notes-app/../page", ""]) {
      await assert.rejects(queryArtifact(directory, attempt, "select 1", []), /is not an artifact id/, attempt);
    }

    await assert.rejects(queryArtifact(directory, app.id, "   ", []), /one SQL statement/);
    await assert.rejects(queryArtifact(directory, app.id, "select 1", "drop"), /parameters are an array/);
    await assert.rejects(queryArtifact(directory, app.id, "select 1", [{}]), /Parameter 1 is not something SQLite stores/);
    await assert.rejects(queryArtifact(directory, app.id, "select 1", Array(MAX_ARTIFACT_SQL_PARAMS + 1).fill(1)), /at most 64 parameters/);
    // A select with no bound on it would otherwise build the whole table in memory.
    await assert.rejects(queryArtifact(directory, app.id, `with recursive r(x) as (select 1 union all select x + 1 from r where x < ${MAX_ARTIFACT_ROWS + 100}) select x from r`, []), /Add a LIMIT/);

    // What a page does say: parameters are bound, never spliced, and a boolean is
    // stored as what SQL means by one.
    await queryArtifact(directory, app.id, "create table note (body text, done integer)", []);
    await queryArtifact(directory, app.id, "insert into note values (?, ?)", ["'; drop table note; --", true]);
    assert.deepEqual(await queryArtifact(directory, app.id, "select body, done from note", []), [{ body: "'; drop table note; --", done: 1 }]);

    // The ceiling is SQLite's own, so the write that would cross it fails rather
    // than the file growing until the disk notices.
    const [{ page_size: pageSize }] = await queryArtifact(directory, app.id, "pragma page_size", []) as { page_size: number }[];
    const [{ max_page_count: cap }] = await queryArtifact(directory, app.id, "pragma max_page_count", []) as { max_page_count: number }[];
    assert.equal(cap, Math.floor(MAX_ARTIFACT_DB_BYTES / pageSize));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/* An app is several files, and every one of their names arrives from a model or
   from a page's own `<script src>`. None of them may name anything outside the
   artifact's folder, and none may be one of the three the folder already owns. */
test("an app's files stay inside its folder, and a file bumps the version", async () => {
  const directory = await userData();
  try {
    const app = await writeArtifact(directory, { title: "Budget", kind: "app", content: '<!doctype html><script src="app.js"></script>' });
    await writeArtifact(directory, { id: "notes", title: "Notes", kind: "markdown", content: "plain" });

    const saved = await writeArtifactFile(directory, app.id, "app.js", "const rows = await emma.sql('select 1')");
    assert.equal(saved.version, 2, "the frame's URL is keyed on the version, so a changed file has to move it");
    assert.equal(await readArtifactFile(directory, app.id, "app.js"), "const rows = await emma.sql('select 1')");
    await writeArtifactFile(directory, app.id, "style.css", "body { margin: 0 }");
    assert.deepEqual(await artifactFiles(directory, app.id), ["app.js", "style.css"], "the entry, the metadata and the database are not files it holds");

    const edited = await updateArtifactFile(directory, app.id, "style.css", "margin: 0", "margin: 2rem");
    assert.equal(edited.version, 4);
    assert.equal(await readArtifactFile(directory, app.id, "style.css"), "body { margin: 2rem }");
    await assert.rejects(updateArtifactFile(directory, app.id, "style.css", "padding", "x"), /did not appear verbatim in style\.css in budget/);

    for (const attempt of ["../evil.js", "app.js/../../evil.js", "..%2Fevil.js", ".hidden.js", "sub/app.js", "meta.json", "content.html", ARTIFACT_DB_FILE, "app.exe", "APP.JS", "app.js.map"]) {
      await assert.rejects(writeArtifactFile(directory, app.id, attempt, "x"), /is not a file an artifact can hold/, attempt);
      await assert.rejects(readArtifactFile(directory, app.id, attempt), /is not a file an artifact can hold/, attempt);
    }
    // Only an app is several files; every other kind is the one document it is.
    await assert.rejects(writeArtifactFile(directory, "notes", "app.js", "x"), /which is one file/);
    await assert.rejects(writeArtifactFile(directory, app.id, "big.js", "x".repeat(MAX_ARTIFACT_BYTES + 1)), /larger than 512K/);
    await assert.rejects(readArtifactFile(directory, app.id, "missing.js"), /has no file called "missing\.js"/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// The two halves live in different processes: main writes the marker, the
// transcript reads it back to draw the card. Drift between them loses the card
// silently, so they are checked against each other rather than against a literal.
test("the transcript reads back the marker the tool writes", () => {
  // Built as a variable, not passed as a literal: `artifactWritten` takes only
  // what it reads, so a literal carrying `kind` is an excess-property error —
  // which is the point. The category cannot be consulted even by mistake.
  const step = (output: string, kind = "artifact", status = "completed") => artifactWritten({ kind, status, output } as { kind: string; status: string; output: string });
  assert.equal(step(`${artifactMarker("flight-tracker")} Created the artifact "Flight tracker"\nIt is on the Artifacts page.`), "flight-tracker");
  assert.equal(step(`${artifactMarker("notes")} Updated "Notes" — one replacement, now v2`), "notes");
  assert.equal(step("Deleted the artifact notes."), undefined, "only a write draws a card");
  assert.equal(step(`${artifactMarker("notes")} Created "Notes"`, "artifact", "failed"), undefined, "a call that failed made nothing");
  // Leading, not trailing: a 200-byte cut takes the tail, never the head.
  assert.equal(step(`Created the artifact "Notes" ${artifactMarker("notes")}`), undefined, "the marker is only read where it is written — first");

  // The regression this exists for. On the harness, `kind` is ACP's fixed
  // category — an `artifact` call comes through as `other` — so a card drawn
  // only for `kind === "artifact"` never appeared on the loop that is actually
  // in use. The marker is the contract; the category is not.
  assert.equal(step(`${artifactMarker("flight-tracker")} Rewrote "Flight tracker" — now v3`, "other"), "flight-tracker");
});

/* The same cut the marker is anchored against, at the other end: the harness
   truncates an MCP tool's description at 1024 bytes, and everything this tool has
   to say about ids, files and the marker is in the tail. Adding a sentence is what
   pushes it over, silently, so the ceiling is asserted rather than commented. */
test("the artifact tool still says all of itself inside the harness's cut", () => {
  const tool = toolDefinitions("auto", { folders: true, computer: true }).find((candidate) => candidate.name === "artifact");
  assert.ok(tool, "the artifact tool is always advertised");
  assert.ok(Buffer.byteLength(tool.description) <= 1024, `the description is ${Buffer.byteLength(tool.description)} bytes; over 1024 the harness cuts the tail off`);
  assert.match(tool.description, /\[artifact:id\]/, "the marker rule is the last thing said, so it is the first thing lost");
});

test("the tool refuses a call the store would have to guess at", () => {
  assert.deepEqual(parseToolArgs("artifact", "{}"), { name: "artifact", action: "list", id: undefined, file: undefined, title: undefined, kind: undefined, language: undefined, surface: undefined, content: undefined, oldStr: undefined, newStr: undefined });
  assert.throws(() => parseToolArgs("artifact", JSON.stringify({ action: "publish" })), /action must be one of/);
  // Deleting is the user's, behind the confirmation on the Artifacts page: this
  // tool is ungated so a scheduled task can write unattended, and an ungated
  // action that takes their kept work off disk is the one not worth having.
  assert.throws(() => parseToolArgs("artifact", JSON.stringify({ action: "delete", id: "notes" })), /action must be one of/);
  assert.throws(() => parseToolArgs("artifact", JSON.stringify({ action: "get" })), /The "id" argument is required/);
  assert.throws(() => parseToolArgs("artifact", JSON.stringify({ action: "create", kind: "markdown", content: "x" })), /The "title" argument is required/);
  assert.throws(() => parseToolArgs("artifact", JSON.stringify({ action: "create", title: "One", kind: "markdown" })), /whole text/);
  assert.throws(() => parseToolArgs("artifact", JSON.stringify({ action: "update", id: "one", old_str: "a" })), /old_str.*new_str/);
  assert.throws(() => parseToolArgs("artifact", JSON.stringify({ action: "create", title: "One", kind: "markdown", content: "x".repeat(MAX_ARTIFACT_BYTES + 1) })), /longer than/);
  // A file belongs to an artifact that already exists, and create is the action
  // that mints the id — so there is nothing for it to be created inside of yet.
  assert.throws(() => parseToolArgs("artifact", JSON.stringify({ action: "create", title: "App", kind: "app", content: "x", file: "app.js" })), /Create the app first/);
});

/* Emma's own interface, as artifacts. The rules worth a test are the three that
   are silent when they break: an edit that quietly hands a live region back to the
   built-in, a mount the renderer cannot import, and two modules over one region. */
test("a module takes over a region, stays there through an edit, and hands it back", async () => {
  const directory = await userData();
  try {
    const source = "export default ({ h }) => () => h('nav', null, 'Today');";
    const mounted = await writeArtifact(directory, { title: "Today", kind: "code", language: "js", surface: "navbar", content: source });
    assert.equal(mounted.surface, "navbar");

    // The one that matters: `surface` is left out of every ordinary edit, so a
    // region that gave itself back on its first fix would be a bug with no visible cause.
    assert.equal((await updateArtifact(directory, "today", "Today", "Today ·")).surface, "navbar");
    assert.equal((await writeArtifact(directory, { id: "today", title: "Today", kind: "code", content: source })).surface, "navbar");
    assert.equal((await listArtifacts(directory))[0].surface, "navbar", "and it survives the round trip through meta.json");

    assert.equal((await writeArtifact(directory, { id: "today", title: "Today", kind: "code", surface: "none", content: source })).surface, undefined);
    // Turning a mounted module into a document hands the region back: there is nothing left to import.
    await writeArtifact(directory, { id: "today", title: "Today", kind: "code", surface: "chat", content: source });
    assert.equal((await writeArtifact(directory, { id: "today", title: "Today", kind: "markdown", content: "# Out" })).surface, undefined);

    await assert.rejects(writeArtifact(directory, { title: "Notes", kind: "markdown", surface: "navbar", content: "x" }), /does not run/);
    await assert.rejects(writeArtifact(directory, { title: "Notes", kind: "code", surface: "sidebar", content: "x" }), /is not a region/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a region is one module — a second one is refused, not silently ignored", async () => {
  const directory = await userData();
  try {
    const source = "export default ({ h }) => () => h('div');";
    await writeArtifact(directory, { title: "Mine", kind: "code", surface: "context", content: source });
    // The renderer takes the first match, so a second mount would be a module that
    // saved without complaint and never appeared.
    await assert.rejects(writeArtifact(directory, { title: "Also mine", kind: "code", surface: "context", content: source }), /already "Mine"/);
    // The one holding it does not count against itself, so rewriting it still works.
    assert.equal((await writeArtifact(directory, { id: "mine", title: "Mine", kind: "code", surface: "context", content: source })).surface, "context");
    // A different region is free.
    assert.equal((await writeArtifact(directory, { title: "Elsewhere", kind: "code", surface: "notch", content: source })).surface, "notch");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
