import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { branchPrefixName, gitArgv, layoutHistory, matchesFilter, parseDiff, parseStatus, parseWorktrees, validateGitArgs, worktreeName, type GitCommit } from "../shared/git";
import { addWorktree, cleanMessage, commit, discard, gitFailure, gitHistory, gitReady, gitSnapshot, initRepo, listWorktrees, mainCheckout, NO_GIT, removeWorktrees, runGit, switchBranch, writeCommitMessage } from "../main/git";

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

type Repo = { root: string; repo: string; run: (...args: string[]) => string };

function makeRepo(): Repo {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "emma-git-")));
  const repo = path.join(root, "project");
  execFileSync("git", ["init", "-q", "-b", "main", repo], { cwd: root, stdio: "pipe" });
  const run = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" }).toString();
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Test");
  return { root, repo, run };
}

function write(repo: string, name: string, body: string) {
  writeFileSync(path.join(repo, name), body);
}

test("git diff output splits into files with their own counts", () => {
  const files = parseDiff(DIFF);
  assert.deepEqual(files.map((file) => file.path), ["src/one.ts", "new.txt", "old.txt"]);
  assert.deepEqual(files.map((file) => [file.added, file.removed]), [[2, 1], [1, 0], [0, 1]]);
  assert.deepEqual(files[0].lines, [
    { kind: "@", text: "@@ -1,3 +1,3 @@" },
    { kind: " ", text: "const kept = 1;" },
    { kind: "-", text: "const gone = 2;" },
    { kind: "+", text: "const added = 2;" },
    { kind: "+", text: "const also = 3;" },
  ]);
});

test("the per-file line cap is the caller's, and the counts ignore it", () => {
  const [first] = parseDiff(DIFF, 2);
  assert.equal(first.lines.length, 2);
  assert.deepEqual([first.added, first.removed], [2, 1]);
});

test("a diff with no files parses to nothing rather than throwing", () => {
  assert.deepEqual(parseDiff(""), []);
});

test("status lines carry renames and untracked files through with their states", () => {
  const entries = parseStatus(["R  old/name.ts -> new/name.ts", "?? scratch.txt", " M edited.ts", "D  gone.ts"].join("\n"));
  assert.deepEqual(entries, [
    { path: "new/name.ts", index: "R", work: " ", from: "old/name.ts" },
    { path: "scratch.txt", index: "?", work: "?" },
    { path: "edited.ts", index: " ", work: "M" },
    { path: "gone.ts", index: "D", work: " " },
  ]);
});

test("a fork and a merge get lanes of their own that never collide", () => {
  const commit = (hash: string, ...parents: string[]): GitCommit =>
    ({ hash, parents, subject: hash, author: "Test", when: 0, refs: [] });
  const rows = layoutHistory([
    commit("merge", "main2", "side1"),
    commit("main2", "base"),
    commit("side1", "base"),
    commit("base"),
  ]);
  assert.deepEqual(rows.map((row) => row.commit.hash), ["merge", "main2", "side1", "base"]);
  const merge = rows[0];
  const first = rows.find((row) => row.commit.hash === "main2")!;
  const second = rows.find((row) => row.commit.hash === "side1")!;
  assert.notEqual(first.lane, second.lane);
  assert.equal(merge.lane, first.lane);
  for (const row of rows) {
    const seen = new Set(row.links.map((link) => link.to));
    assert.equal(seen.size, row.links.length);
    for (const link of row.links) assert.ok(link.to < row.lanes);
  }
  assert.equal(rows[rows.length - 1].lanes, 0);
});

test("a git command is split into argv the way a shell would, without a shell", () => {
  assert.deepEqual(gitArgv("git commit -m 'two words'"), ["commit", "-m", "two words"]);
  assert.deepEqual(gitArgv('log --format="%H %s"'), ["log", "--format=%H %s"]);
  assert.deepEqual(gitArgv("commit -m ''"), ["commit", "-m", ""]);
  assert.throws(() => gitArgv("commit -m 'unclosed"), /unclosed quote/);
  assert.deepEqual(validateGitArgs(["status", "--short"]), ["status", "--short"]);
  assert.throws(() => validateGitArgs(["-c", "core.pager=cat", "log"]), /subcommand/);
  assert.throws(() => validateGitArgs([]), /subcommand/);
  assert.throws(() => validateGitArgs(["log\0"]), /not something git can be given/);
});

test("a fenced or quoted commit message comes back bare", () => {
  assert.equal(cleanMessage("```\nfeat: add the git page\n```"), "feat: add the git page");
  assert.equal(cleanMessage("```text\nfix: stop the crash\n\nIt was the parser.\n```"), "fix: stop the crash\n\nIt was the parser.");
  assert.equal(cleanMessage('"chore: bump deps"'), "chore: bump deps");
  assert.equal(cleanMessage("<think>weighing it up</think>\n`docs: fix typo`"), "docs: fix typo");
});

test("the commit writer sends the model a quoted diff and returns what it said", async () => {
  let seen = "";
  const ask = async (_settings: unknown, messages: { role: string; content: unknown }[]) => {
    seen = String(messages[1].content);
    return "```\nfeat(git): add a dedicated git page\n```";
  };
  const settings = { model: "test", endpoint: "http://localhost/none", credentialEnv: "", system: "" };
  const text = await writeCommitMessage(settings, {
    diff: DIFF,
    files: [{ path: "src/one.ts", index: " ", work: "M" }],
    ask: ask as never,
  });
  assert.equal(text, "feat(git): add a dedicated git page");
  assert.match(seen, /<<<DIFF/);
  assert.match(seen, /modified\tsrc\/one\.ts/);
  await assert.rejects(
    writeCommitMessage({ model: "", endpoint: "", credentialEnv: "", system: "" }, { diff: DIFF, files: [] }),
    /No model is set up/,
  );
  await assert.rejects(
    writeCommitMessage(settings, { diff: DIFF, files: [], ask: (async () => "   ") as never }),
    /answered with nothing/,
  );
  const parroted = "You write the commit message for a change someone is about to commit.\n\nFiles in this commit:\nmodified\tsrc/one.ts";
  await assert.rejects(
    writeCommitMessage(settings, { diff: DIFF, files: [], ask: (async () => parroted) as never }),
    /read the prompt back/,
  );
});

test("worktree porcelain records split on NULs and keep paths whole", () => {
  const text = ["worktree /repo/main", "HEAD abc1234", "branch refs/heads/main", "", "worktree /repo/my trees/naïve", "HEAD def5678", "detached", "", "worktree /repo/locked-one", "branch refs/heads/feature", "locked reason goes here", "", "worktree /repo/stale", "prunable: junk on disk", "", ""].join("\0");
  const rows = parseWorktrees(text, "/repo/main");
  assert.deepEqual(rows, [
    { path: "/repo/main", head: "abc1234", branch: "main", primary: true, bare: false, detached: false, locked: false, prunable: false, dirty: false },
    { path: "/repo/my trees/naïve", head: "def5678", branch: "", primary: false, bare: false, detached: true, locked: false, prunable: false, dirty: false },
    { path: "/repo/locked-one", head: "", branch: "feature", primary: false, bare: false, detached: false, locked: true, prunable: false, dirty: false },
    { path: "/repo/stale", head: "", branch: "", primary: false, bare: false, detached: false, locked: false, prunable: true, dirty: false },
  ]);
  assert.deepEqual(parseWorktrees("", "/repo/main"), []);
});

test("a branch prefix joins onto a cleaned name and refuses an empty one", () => {
  assert.equal(branchPrefixName("emma/", "happy otter"), "emma/happy-otter");
  assert.equal(branchPrefixName("", "feature"), "feature");
  assert.equal(branchPrefixName("anurag", "--weird--name--"), "anurag/weird-name");
  assert.equal(branchPrefixName("emma/", "a/b"), "emma/a-b");
  assert.throws(() => branchPrefixName("emma/", "   "), /name/);
  assert.throws(() => branchPrefixName("emma/", "---"), /name/);
});

test("the worktree list reports dirty state and removal is refused for the primary and unknown paths", async () => {
  const { root, repo, run } = makeRepo();
  try {
    write(repo, "one.txt", "hello\n");
    run("add", "-A");
    run("commit", "-q", "-m", "first");

    const tree = await addWorktree(repo, "side");
    const rows = await listWorktrees(repo);
    assert.equal(rows.length, 2);
    const main = rows.find((row) => row.primary);
    const side = rows.find((row) => row.path === tree);
    assert.equal(main?.branch, "main");
    assert.equal(main?.dirty, false);
    assert.equal(side?.branch, "side");
    assert.equal(side?.dirty, false);

    write(tree, "scratch.txt", "uncommitted\n");
    const dirty = await listWorktrees(repo);
    assert.equal(dirty.find((row) => row.path === tree)?.dirty, true);

    await assert.rejects(removeWorktrees(repo, [repo]), /main checkout/);
    await assert.rejects(removeWorktrees(repo, ["/nowhere/else"]), /Refresh and try again/);
    await assert.rejects(removeWorktrees(repo, []), /Pick the worktrees/);
    await assert.rejects(removeWorktrees(repo, [tree]), /--force/);
    run("-C", tree, "clean", "-f", "scratch.txt");
    await removeWorktrees(repo, [tree]);
    const after = await listWorktrees(repo);
    assert.deepEqual(after.map((row) => row.path), [repo]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

 test("a thread moves onto a worktree of its repo and back to the main checkout", async () => {
  const { root, repo, run } = makeRepo();
  try {
    write(repo, "one.txt", "hello\n");
    run("add", "-A");
    run("commit", "-q", "-m", "first");

    const name = worktreeName("9f3c21ab-0000-4000-8000-000000000000");
    assert.equal(name, "emma-9f3c21ab");
    const tree = await addWorktree(repo, name);
    assert.equal(tree, path.join(root, "project-worktrees", name));
    assert.equal(await addWorktree(repo, name), tree);

    const snapshot = await gitSnapshot(tree);
    assert.equal(snapshot?.branch, name);
    assert.equal(snapshot?.worktree, true);
    assert.equal((await gitSnapshot(repo))?.worktree, false);
    assert.equal(await mainCheckout(tree), repo);
    assert.equal(await mainCheckout(repo), repo);

    await switchBranch(repo, "spike", true);
    const started = await gitSnapshot(repo);
    assert.equal(started?.branch, "spike");
    assert.deepEqual([...(started?.branches ?? [])].sort(), ["emma-9f3c21ab", "main", "spike"]);
    await switchBranch(repo, "main", false);
    assert.equal((await gitSnapshot(repo))?.branch, "main");
    await assert.rejects(switchBranch(repo, "bad branch", true));
    await assert.rejects(switchBranch(repo, "--force", true));
    assert.equal((await gitSnapshot(repo))?.branch, "main");

    run("switch", "-q", "spike");
    write(repo, "two.txt", "on spike\n");
    run("add", "-A");
    run("commit", "-q", "-m", "spike only");
    run("switch", "-q", "main");
    await switchBranch(repo, "off-spike", true, "spike");
    assert.equal((await gitSnapshot(repo))?.branch, "off-spike");
    assert.equal(run("log", "-1", "--format=%s").trim(), "spike only");
    await assert.rejects(switchBranch(repo, "nowhere", true, "no-such-branch"));
    await switchBranch(repo, "main", false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the snapshot carries head, upstream, ahead and behind, and the changed files", async () => {
  const { root, repo, run } = makeRepo();
  try {
    write(repo, "one.txt", "hello\n");
    run("add", "-A");
    run("commit", "-q", "-m", "first");

    const remote = path.join(root, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", remote], { cwd: root, stdio: "pipe" });
    run("remote", "add", "origin", remote);
    run("push", "-q", "-u", "origin", "main");

    write(repo, "one.txt", "hello again\n");
    write(repo, "two.txt", "brand new\n");
    run("commit", "-q", "-am", "second");

    const snapshot = await gitSnapshot(repo);
    assert.ok(snapshot);
    assert.equal(snapshot!.branch, "main");
    assert.equal(snapshot!.upstream, "origin/main");
    assert.equal(snapshot!.ahead, 1);
    assert.equal(snapshot!.behind, 0);
    assert.deepEqual(snapshot!.remotes, ["origin"]);
    assert.match(snapshot!.head, /^[0-9a-f]{7,}$/);
    assert.deepEqual(snapshot!.files, [{ path: "two.txt", index: "?", work: "?" }]);
    assert.match(snapshot!.diff, /\+brand new/);
    assert.equal(snapshot!.truncated, false);
    assert.equal(await gitSnapshot(root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an empty repo answers with a snapshot and an empty history rather than throwing", async () => {
  const { root, repo } = makeRepo();
  try {
    const snapshot = await gitSnapshot(repo);
    assert.equal(snapshot?.branch, "main");
    assert.equal(snapshot?.head, "");
    assert.equal(snapshot?.upstream, "");
    assert.deepEqual(await gitHistory(repo, { skip: 0, limit: 10 }), { commits: [], more: false });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("history pages, and says when there is another page behind it", async () => {
  const { root, repo, run } = makeRepo();
  try {
    for (let step = 1; step <= 5; step += 1) {
      write(repo, "log.txt", `step ${step}\n`);
      run("add", "-A");
      run("commit", "-q", "-m", `step ${step}`);
    }
    const first = await gitHistory(repo, { skip: 0, limit: 2 });
    assert.equal(first.commits.length, 2);
    assert.equal(first.more, true);
    assert.deepEqual(first.commits.map((entry) => entry.subject), ["step 5", "step 4"]);
    assert.equal(first.commits[0].author, "Test");
    assert.ok(first.commits[0].when > 0);
    assert.deepEqual(first.commits[0].refs, ["main"]);

    const last = await gitHistory(repo, { skip: 4, limit: 2 });
    assert.equal(last.commits.length, 1);
    assert.equal(last.more, false);
    assert.deepEqual(last.commits.map((entry) => entry.subject), ["step 1"]);

    const merged = await gitHistory(repo, { skip: -5, limit: 9_999 });
    assert.equal(merged.commits.length, 5);
    assert.equal(merged.more, false);

    run("switch", "-q", "-c", "sidelined");
    write(repo, "side.txt", "off to the side\n");
    run("add", "-A");
    run("commit", "-q", "-m", "off on a branch");
    run("switch", "-q", "main");
    const every = await gitHistory(repo, { skip: 0, limit: 9_999 });
    assert.ok(every.commits.some((entry) => entry.subject === "off on a branch"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a deletion already staged still commits rather than failing the add", async () => {
  const { root, repo, run } = makeRepo();
  try {
    write(repo, "gone.txt", "bye\n");
    write(repo, "stays.txt", "here\n");
    run("add", "-A");
    run("commit", "-q", "-m", "first");
    run("rm", "-q", "gone.txt");
    write(repo, "stays.txt", "changed\n");

    const before = await gitSnapshot(repo);
    assert.equal(before?.files.find((file) => file.path === "gone.txt")?.work, " ");
    await commit(repo, { message: "chore: drop the file", paths: ["gone.txt"] });
    assert.equal(run("log", "-1", "--format=%s").trim(), "chore: drop the file");
    assert.deepEqual((await gitSnapshot(repo))?.files.map((file) => file.path), ["stays.txt"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("committing a subset of the changed files leaves the rest uncommitted", async () => {
  const { root, repo, run } = makeRepo();
  try {
    write(repo, "kept.txt", "one\n");
    run("add", "-A");
    run("commit", "-q", "-m", "first");
    write(repo, "kept.txt", "two\n");
    write(repo, "fresh.txt", "new file\n");

    const hash = await commit(repo, { message: "feat: only the fresh one", paths: ["fresh.txt"] });
    assert.match(hash, /^[0-9a-f]{7,}$/);
    const after = await gitSnapshot(repo);
    assert.deepEqual(after?.files.map((file) => file.path), ["kept.txt"]);
    assert.equal(run("log", "-1", "--format=%s").trim(), "feat: only the fresh one");

    await assert.rejects(commit(repo, { message: "nothing picked", paths: [] }), /at least one file/);
    await assert.rejects(commit(repo, { message: "", paths: ["kept.txt"] }), /message/);
    await assert.rejects(commit(repo, { message: "ok", paths: ["/etc/passwd"] }), /inside this folder/);
    await assert.rejects(commit(repo, { message: "ok", paths: ["../escape.txt"] }), /inside this folder/);
    await assert.rejects(commit(repo, { message: "ok", paths: ["--force"] }), /inside this folder/);

    await commit(repo, { message: "feat: only the fresh one, amended", paths: [], amend: true });
    assert.equal(run("log", "-1", "--format=%s").trim(), "feat: only the fresh one, amended");
    assert.deepEqual((await gitSnapshot(repo))?.files.map((file) => file.path), ["kept.txt"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discarding restores a tracked file and deletes an untracked one", async () => {
  const { root, repo, run } = makeRepo();
  try {
    write(repo, "kept.txt", "one\n");
    write(repo, "doomed.txt", "two\n");
    run("add", "-A");
    run("commit", "-q", "-m", "first");
    write(repo, "kept.txt", "edited\n");
    write(repo, "loose.txt", "never committed\n");
    unlinkSync(path.join(repo, "doomed.txt"));

    await discard(repo, ["kept.txt", "loose.txt", "doomed.txt"]);
    assert.equal(readFileSync(path.join(repo, "kept.txt"), "utf8"), "one\n");
    assert.equal(readFileSync(path.join(repo, "doomed.txt"), "utf8"), "two\n");
    assert.equal(existsSync(path.join(repo, "loose.txt")), false);
    assert.deepEqual((await gitSnapshot(repo))?.files, []);

    await assert.rejects(discard(repo, []), /at least one file/);
    await assert.rejects(discard(repo, ["../outside.txt"]), /inside this folder/);
    await assert.rejects(discard(repo, "kept.txt"), /not something git can be given/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an arbitrary git command comes back as output, failures included", async () => {
  const { root, repo, run } = makeRepo();
  try {
    write(repo, "one.txt", "hello\n");
    run("add", "-A");
    run("commit", "-q", "-m", "first");

    const ok = await runGit(repo, ["status", "--short", "--branch"]);
    assert.equal(ok.ok, true);
    assert.match(ok.output, /## main/);

    const bad = await runGit(repo, gitArgv("git bogus-subcommand"));
    assert.equal(bad.ok, false);
    assert.match(bad.output, /bogus-subcommand/);

    const refused = await runGit(repo, ["push", "origin", "main"]);
    assert.equal(refused.ok, false);
    assert.ok(refused.output.length > 0);

    await assert.rejects(runGit(repo, ["-c", "log"]), /subcommand/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a git refusal is shown without execFile's preamble", () => {
  const failure = new Error("Command failed: git switch feature\nerror: Your local changes would be overwritten by checkout.\n");
  assert.equal(gitFailure(failure), "error: Your local changes would be overwritten by checkout.");
  assert.equal(gitFailure(new Error("Command failed: git status")), "Command failed: git status");
  assert.equal(gitFailure("boom"), "boom");
});

test("a plain folder reports no repository, and git init turns it into one", async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "emma-git-")));
  const repo = path.join(root, "project");
  try {
    execFileSync("mkdir", ["-p", repo]);
    assert.equal(await gitReady(repo), "no-repo");
    assert.equal(await gitSnapshot(repo), null);
    await initRepo(repo);
    assert.equal(await gitReady(repo), "ready");
    const path_ = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try { assert.equal(await gitReady(repo), "no-git"); } finally { process.env.PATH = path_; }
    assert.equal((await gitSnapshot(repo))?.files.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing git binary is named rather than leaking spawn ENOENT", () => {
  assert.equal(gitFailure(Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" })), NO_GIT);
});

test("matchesFilter takes extensions, substrings, fuzzy names and every term", () => {
  assert.equal(matchesFilter("", "desktop/main/main.ts"), true);
  assert.equal(matchesFilter(".ts", "desktop/main/main.ts"), true);
  assert.equal(matchesFilter("*.ts", "desktop/main/main.tsx"), false);
  assert.equal(matchesFilter("main/", "desktop/main/main.ts"), true);
  assert.equal(matchesFilter("MAIN", "desktop/main/main.ts"), true);
  assert.equal(matchesFilter("agtlp", "desktop/main/agent-loop.ts"), true);
  assert.equal(matchesFilter("agtlp", "desktop/main/main.ts"), false);
  assert.equal(matchesFilter("main .md", "desktop/main/main.ts"), false);
  assert.equal(matchesFilter("readme .md", "docs/README.md"), true);
});
