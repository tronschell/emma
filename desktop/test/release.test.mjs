import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkPullRequest, checkVersionAdvance, releasePlan, stableVersion, verifyCandidate } from "../scripts/release.mjs";

test("feature PRs target dev and only the same repository's dev promotes to main", () => {
  const repository = "tronschell/emma";
  const pr = (base, head, repo = repository, title = "fix(release): verify the app") => ({ title, base: { ref: base }, head: { ref: head, repo: { full_name: repo } } });
  checkPullRequest(pr("dev", "feat/example", "contributor/emma"), repository);
  checkPullRequest(pr("dev", "release-please--branches--dev"), repository);
  checkPullRequest(pr("main", "dev"), repository);
  assert.throws(() => checkPullRequest(pr("main", "feat/example"), repository), /Only dev/);
  assert.throws(() => checkPullRequest(pr("main", "dev", "contributor/emma"), repository), /not a fork/);
  assert.throws(() => checkPullRequest(pr("dev", "feature", repository, "Update the app"), repository), /conventional/);
  assert.throws(() => checkPullRequest(pr("dev", "feature", repository, "fix: valid\ninvalid"), repository), /conventional/);
});

test("only increasing stable versions can be promoted and published releases are never overwritten", () => {
  for (const version of ["0.1.1", "1.0.0", "10.0.0"]) checkVersionAdvance(version, "0.1.0");
  for (const version of ["0.1.0", "0.0.9"]) assert.throws(() => checkVersionAdvance(version, "0.1.0"));
  for (const version of ["1.0", "1.0.0-beta.1", "v1.0.0", "01.0.0", "1.0.0\n", undefined]) assert.throws(() => stableVersion(version));
  const candidate = { version: "1.0.0", tag: "v1.0.0" };
  const draft = { tagName: candidate.tag, isDraft: true, isPrerelease: false };
  assert.deepEqual(releasePlan(candidate, draft), { ...candidate, publish: true });
  assert.equal(releasePlan(candidate, { ...draft, isDraft: false }).publish, false);
  assert.throws(() => releasePlan(candidate, { ...draft, tagName: "v2.0.0" }));
  assert.throws(() => releasePlan(candidate, { ...draft, isPrerelease: true }));
});

test("a promotion must contain exactly the prepared, tagged release tree", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "emma-release-test-"));
  const git = (...args) => execFileSync("git", args, { cwd, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "Emma test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Emma test", GIT_COMMITTER_EMAIL: "test@example.invalid" } }).toString().trim();
  const write = (name, value) => writeFileSync(path.join(cwd, name), JSON.stringify(value));
  try {
    git("init", "--initial-branch=main");
    write("package.json", { version: "0.1.0" });
    write(".release-please-manifest.json", { ".": "0.1.0" });
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-m", "chore: initial");
    git("switch", "-c", "dev");
    write("package.json", { version: "1.0.0" });
    write(".release-please-manifest.json", { ".": "1.0.0" });
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-m", "chore(dev): release 1.0.0");
    assert.throws(() => verifyCandidate(cwd));
    git("-c", "tag.gpgsign=false", "tag", "v1.0.0");
    git("switch", "main");
    git("-c", "commit.gpgsign=false", "merge", "--no-ff", "dev", "-m", "chore(release): promote dev");
    assert.deepEqual(verifyCandidate(cwd), { version: "1.0.0", tag: "v1.0.0" });
    write("extra.json", { unreviewed: true });
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-m", "fix: unprepared change");
    assert.throws(() => verifyCandidate(cwd), /candidate changed/);
    write(".release-please-manifest.json", { ".": "2.0.0" });
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-m", "chore: inconsistent manifest");
    assert.throws(() => verifyCandidate(cwd), /must agree/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
