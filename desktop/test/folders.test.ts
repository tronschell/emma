import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { FolderStore } from "../main/folders";
import { isImageAttachment } from "../main/attachments";
import { pathInside, realPath, realPathInside } from "../main/platform";
import { contextBlock, MAX_FILE_BYTES, MAX_FOLDER_COUNT, MAX_FOLDER_FILES, mergeSkillContext, slashName } from "../shared/folders";

function workspace() {
  const root = mkdtempSync(path.join(tmpdir(), "emma-folders-"));
  const project = path.join(root, "project");
  mkdirSync(path.join(project, "notes"), { recursive: true });
  mkdirSync(path.join(project, "node_modules"), { recursive: true });
  writeFileSync(path.join(project, "readme.md"), "# hello");
  writeFileSync(path.join(project, "notes", "plan.txt"), "plan");
  writeFileSync(path.join(project, "photo.heic"), "binary");
  writeFileSync(path.join(project, "node_modules", "dep.js"), "skip me");
  writeFileSync(path.join(root, "secret.md"), "outside the grant");
  return { root, project, store: new FolderStore(root) };
}

test("a grant lists its text files and skips vendored and non-text ones", () => {
  const { project, store } = workspace();
  const [grant] = store.add(project);
  assert.deepEqual(store.files(grant.id).files.map((file) => file.path), ["notes/plan.txt", "readme.md"]);
  assert.equal(store.files(grant.id).total, 2);
  assert.equal(store.files(grant.id).capped, false);
  assert.equal(store.read(grant.id, "readme.md").text, "# hello");
});

test("a capped listing still counts every file it walked past", () => {
  const { project, store } = workspace();
  const many = path.join(project, "many");
  mkdirSync(many, { recursive: true });
  for (let index = 0; index < MAX_FOLDER_FILES + 20; index += 1) writeFileSync(path.join(many, `mod${index}.ts`), "export const v = 1;");
  const [grant] = store.add(project);
  const listing = store.files(grant.id);
  assert.equal(listing.files.length, MAX_FOLDER_FILES);
  assert.equal(listing.total, MAX_FOLDER_FILES + 22);
  assert.equal(listing.capped, false);
});

test("the total counts only files the listing would accept, on both sides of the cap", () => {
  const { project, store } = workspace();
  for (let bucket = 0; bucket < 30; bucket += 1) {
    const directory = path.join(project, `bucket${bucket}`);
    mkdirSync(directory, { recursive: true });
    for (let index = 0; index < 20; index += 1) writeFileSync(path.join(directory, `mod${index}.ts`), "export const v = 1;");
    const oversized = path.join(directory, "oversized.ts");
    writeFileSync(oversized, "");
    truncateSync(oversized, MAX_FILE_BYTES + 1);
  }
  const [grant] = store.add(project);
  const listing = store.files(grant.id);
  assert.equal(listing.files.length, MAX_FOLDER_FILES);
  assert.equal(listing.files.some((file) => file.bytes > MAX_FILE_BYTES), false);
  assert.equal(listing.total, 602);
});

test("the walk stops at MAX_FOLDER_COUNT instead of reading the whole tree", () => {
  const { project, store } = workspace();
  for (let bucket = 0; bucket < 6; bucket += 1) {
    const directory = path.join(project, `bucket${bucket}`);
    mkdirSync(directory, { recursive: true });
    for (let index = 0; index < 400; index += 1) writeFileSync(path.join(directory, `mod${index}.ts`), "export const v = 1;");
  }
  const [grant] = store.add(project);
  const listing = store.files(grant.id);
  assert.equal(listing.total, MAX_FOLDER_COUNT);
  assert.equal(listing.capped, true);
  assert.equal(listing.files.length, MAX_FOLDER_FILES);
});

test("a missing optional file reads as empty rather than throwing", () => {
  const { project, store } = workspace();
  const [grant] = store.add(project);
  assert.deepEqual(store.read(grant.id, "AGENTS.md"), { path: "AGENTS.md", text: "", missing: true });
});

test("a read cannot escape the granted folder, and an unknown grant is refused", () => {
  const { project, store } = workspace();
  const [grant] = store.add(project);
  assert.throws(() => store.read(grant.id, "../secret.md"));
  assert.throws(() => store.read("not-a-grant", "readme.md"));
});

/* What the "Open in" row on the thread bar sends when it names no file: the editor
   is handed the project, and the same walk still refuses anything above it. */
test("the folder itself is a path inside the grant, and cannot be climbed out of", () => {
  const { project, store } = workspace();
  const [grant] = store.add(project);
  assert.equal(store.within(grant.id, "."), ".");
  assert.equal(path.join(store.directory(grant.id), store.within(grant.id, ".")), store.directory(grant.id));
  assert.throws(() => store.within(grant.id, "../secret.md"));
});

test("adding the same folder twice keeps one grant, and forgetting drops it", () => {
  const { project, store } = workspace();
  const [grant] = store.add(project);
  assert.equal(store.add(project).length, 1);
  assert.deepEqual(store.remove(grant.id), []);
});

test("the context block drops whole sections once its budget is gone", () => {
  const block = contextBlock([{ heading: "One", body: "a".repeat(50) }, { heading: "Two", body: "b".repeat(500) }], 200);
  assert.match(block, /## One/);
  assert.doesNotMatch(block, /## Two/);
  assert.match(block, /1 more attachment omitted/);
  assert.equal(contextBlock([]), "");
});

test("merged context stays inside the host's skill-context ceiling", () => {
  assert.equal(mergeSkillContext("files", "skill"), "files\n\nskill");
  assert.ok(new TextEncoder().encode(mergeSkillContext("x".repeat(90_000), "y".repeat(90_000))).length <= 64 * 1024);
});

test("a slash name is one word in the command alphabet", () => {
  assert.equal(slashName("notes/my plan (final).md"), "my-plan-final-.md");
  assert.equal(slashName("///"), "file");
});

const mainSource = ts.createSourceFile("main.ts", readFileSync(path.join(__dirname, "../../main/main.ts"), "utf8"), ts.ScriptTarget.Latest, true);

function mainFunction(name: string): string {
  const declaration = mainSource.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, name);
  return declaration.getText(mainSource);
}

function mainHandler(channel: string): string {
  let found: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(mainSource) === "ipcMain.handle" && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === channel) found = node.arguments[1];
    else ts.forEachChild(node, visit);
  };
  visit(mainSource);
  assert.ok(found, channel);
  return found.getText(mainSource);
}

function pathHandlers() {
  const root = mkdtempSync(path.join(tmpdir(), "emma-preview-"));
  const project = path.join(root, "project");
  mkdirSync(project, { recursive: true });
  writeFileSync(path.join(project, "chart.png"), "inside");
  symlinkSync(path.join(root, "private.png"), path.join(project, "escape.png"));
  symlinkSync(path.join(root, "secret.md"), path.join(project, "escape.md"));
  writeFileSync(path.join(project, "readme.md"), "# inside");
  writeFileSync(path.join(root, "private.png"), "outside");
  writeFileSync(path.join(root, "secret.md"), "outside");
  const attached = path.join(root, "dropped.png");
  writeFileSync(attached, "dropped");
  const previewed: string[] = [];
  const revealed: string[] = [];
  const scope = {
    folders: { list: () => [{ id: "grant-1", path: project }], read: (_id: string, relative: string) => ({ text: readFileSync(path.join(project, relative), "utf8") }) },
    attachments: { holds: (file: string) => file === attached },
    pathInside,
    realPath,
    realPathInside,
    isImageAttachment,
    previewImage: (file: string) => { previewed.push(file); return "data:image/png;base64,MARKER"; },
    mainWindowSender: () => undefined,
    shell: { showItemInFolder: (file: string) => revealed.push(file) },
    statSync,
    readFileSync,
    existsSync,
    homedir: () => root,
    path,
    MAX_FILE_BYTES: 1024 * 1024,
  };
  const code = ts.transpile(`${mainFunction("namedPath")}\n${mainFunction("pathGrant")}\nreturn { preview: ${mainHandler("emma:preview-path")}, reveal: ${mainHandler("emma:reveal-path")} };`, { target: ts.ScriptTarget.ES2022 });
  const handlers = Function(...Object.keys(scope), code)(...Object.values(scope)) as {
    preview: (event: unknown, value: unknown) => { path: string; text: string | null; image?: string | null } | null;
    reveal: (event: unknown, value: unknown) => boolean;
  };
  return { root, project, attached, previewed, revealed, ...handlers };
}

test("a preview only reads inside a grant, and being an image is not a way past it", () => {
  const { root, project, attached, previewed, preview } = pathHandlers();
  assert.deepEqual(preview(null, path.join(project, "chart.png")), { path: path.join(project, "chart.png"), text: null, image: "data:image/png;base64,MARKER" });
  assert.deepEqual(preview(null, path.join(project, "readme.md")), { path: path.join(project, "readme.md"), text: "# inside" });
  assert.deepEqual(preview(null, attached), { path: attached, text: null, image: "data:image/png;base64,MARKER" });
  assert.deepEqual(previewed, [path.join(project, "chart.png"), attached]);

  for (const outside of [path.join(root, "private.png"), path.join(root, "secret.md")]) {
    assert.deepEqual(preview(null, outside), { path: outside, text: null }, outside);
  }
  assert.deepEqual(preview(null, "~/private.png"), { path: path.join(root, "private.png"), text: null });
  assert.equal(preview(null, path.join(root, "nothing.png")), null);
  assert.deepEqual(previewed, [path.join(project, "chart.png"), attached]);
});

test("revealing a path in the file manager asks the same grant question", () => {
  const { root, project, attached, revealed, reveal } = pathHandlers();
  assert.equal(reveal(null, path.join(project, "readme.md")), true);
  assert.equal(reveal(null, attached), true);
  assert.equal(reveal(null, path.join(root, "secret.md")), false);
  assert.equal(reveal(null, path.join(root, "private.png")), false);
  assert.deepEqual(revealed, [path.join(project, "readme.md"), attached]);
});

test("a symlink inside a grant is not a way out of it", () => {
  const { root, project, previewed, preview, reveal } = pathHandlers();
  const escapePng = path.join(project, "escape.png");
  const escapeMd = path.join(project, "escape.md");
  assert.equal(realPath(escapePng), path.join(realPath(root)!, "private.png"));
  assert.equal(pathInside(project, escapePng), true);
  assert.equal(realPathInside(project, escapePng), false);

  assert.deepEqual(preview(null, escapePng), { path: escapePng, text: null });
  assert.deepEqual(preview(null, escapeMd), { path: escapeMd, text: null });
  assert.deepEqual(previewed, []);
  assert.equal(reveal(null, escapePng), false);
  assert.equal(reveal(null, escapeMd), false);
});

test("a grant refuses a symlinked leaf for reads and writes", () => {
  const { root, project, store } = workspace();
  const outside = path.join(root, "secret.md");
  symlinkSync(outside, path.join(project, "escape.md"));
  symlinkSync(root, path.join(project, "door"));
  const [grant] = store.add(project);
  for (const escape of ["escape.md", "door/secret.md"]) {
    assert.throws(() => store.read(grant.id, escape), /outside the granted folder/, escape);
    assert.throws(() => store.within(grant.id, escape), /outside the granted folder/, escape);
    assert.throws(() => store.write(grant.id, escape, "overwritten"), /outside the granted folder/, escape);
  }
  assert.equal(readFileSync(outside, "utf8"), "outside the grant");
});
