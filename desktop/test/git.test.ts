import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseDiff, worktreeName } from "../shared/git";
import { addWorktree, gitFailure, gitSnapshot, mainCheckout, switchBranch } from "../main/git";

const DIFF = `diff --git a/src/one.ts b/src/one.ts
index 111..222 100644
--- a/src/one.ts
+++ b/src/one.ts
@@ -1,3 +1,3 @@
 const kept = 1;
-const gone = 2;
+const added = 2;
+const also = 3;
diff --git a/dev/null b/new.txt
new file mode 100644
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,1 @@
+brand new
diff --git a/old.txt b/old.txt
deleted file mode 100644
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-was here
`;

test("git diff output splits into files with their own counts", () => {
  const files = parseDiff(DIFF);
  assert.deepEqual(files.map((file) => file.path), ["src/one.ts", "new.txt", "old.txt"]);
  assert.deepEqual(files.map((file) => [file.added, file.removed]), [[2, 1], [1, 0], [0, 1]]);
  // The +/- markers are stripped from the text; the kind carries them instead,
  // so a line of source that starts with "-" is not eaten by the renderer.
  assert.deepEqual(files[0].lines, [
    { kind: "@", text: "@@ -1,3 +1,3 @@" },
    { kind: " ", text: "const kept = 1;" },
    { kind: "-", text: "const gone = 2;" },
    { kind: "+", text: "const added = 2;" },
    { kind: "+", text: "const also = 3;" },
  ]);
});

test("the per-file line cap is the caller's, and the counts ignore it", () => {
  // What the rail does; the full-width tab passes Infinity for the same diff.
  const [first] = parseDiff(DIFF, 2);
  assert.equal(first.lines.length, 2);
  assert.deepEqual([first.added, first.removed], [2, 1]);
});

test("a diff with no files parses to nothing rather than throwing", () => {
  assert.deepEqual(parseDiff(""), []);
});

test("a thread moves onto a worktree of its repo and back to the main checkout", async () => {
  // realpath'd because /var is a symlink on macOS and git reports where it landed.
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "emma-git-")));
  const repo = path.join(root, "project");
  const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
  try {
    execFileSync("git", ["init", "-q", "-b", "main", repo], { cwd: root, stdio: "pipe" });
    run(repo, "config", "user.email", "test@example.com");
    run(repo, "config", "user.name", "Test");
    writeFileSync(path.join(repo, "one.txt"), "hello\n");
    run(repo, "add", "-A");
    run(repo, "commit", "-q", "-m", "first");

    const name = worktreeName("9f3c21ab-0000-4000-8000-000000000000");
    assert.equal(name, "emma-9f3c21ab");
    const tree = await addWorktree(repo, name);
    // Beside the repo, never inside it: two checkouts that cannot see each other's files.
    assert.equal(tree, path.join(root, "project-worktrees", name));
    // Asking twice is the same worktree, not a second one or a reset branch.
    assert.equal(await addWorktree(repo, name), tree);

    const snapshot = await gitSnapshot(tree);
    assert.equal(snapshot?.branch, name);
    assert.equal(snapshot?.worktree, true);
    assert.equal((await gitSnapshot(repo))?.worktree, false);
    // Switching back lands on the repo itself, and doing it from the repo is a no-op.
    assert.equal(await mainCheckout(tree), repo);
    assert.equal(await mainCheckout(repo), repo);

    // A repo with one branch can still start the next one, and it comes back listed.
    await switchBranch(repo, "spike", true);
    const started = await gitSnapshot(repo);
    assert.equal(started?.branch, "spike");
    assert.deepEqual([...(started?.branches ?? [])].sort(), ["emma-9f3c21ab", "main", "spike"]);
    // And an existing branch is checked out rather than created a second time.
    await switchBranch(repo, "main", false);
    assert.equal((await gitSnapshot(repo))?.branch, "main");
    // Names git will not take are refused here rather than run.
    await assert.rejects(switchBranch(repo, "bad branch", true));
    await assert.rejects(switchBranch(repo, "--force", true));
    assert.equal((await gitSnapshot(repo))?.branch, "main");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a git refusal is shown without execFile's preamble", () => {
  const failure = new Error("Command failed: git switch feature\nerror: Your local changes would be overwritten by checkout.\n");
  assert.equal(gitFailure(failure), "error: Your local changes would be overwritten by checkout.");
  // Nothing but the preamble leaves the original rather than an empty banner.
  assert.equal(gitFailure(new Error("Command failed: git status")), "Command failed: git status");
  assert.equal(gitFailure("boom"), "boom");
});
