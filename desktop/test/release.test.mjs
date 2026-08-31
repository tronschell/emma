import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkPullRequest, checkVersionAdvance, releasePlan, stableVersion, verifyCandidate } from "../scripts/release.mjs";

test("dev checks never compile the app and full CI only targets main", () => {
  const workflow = (name) => readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), "utf8");
  assert.match(workflow("ci"), /pull_request:\n {4}branches: \[main\]/);
  assert.doesNotMatch(workflow("ci"), /^\s+push:/m);
  const dev = workflow("dev");
  assert.match(dev, /pull_request:\n {4}branches: \[dev\]/);
  assert.deepEqual([...dev.matchAll(/^\s+run: (.+)$/gm)].map((match) => match[1]), ["node desktop/scripts/release.mjs pr", "node --test desktop/test/release.test.mjs"]);
  assert.deepEqual([...dev.matchAll(/^\s+- uses: (.+)$/gm)].map((match) => match[1]), ["actions/checkout@v5", "actions/setup-node@v5"]);
});

test("main checks cover Windows x64 and ARM64 native builds", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(workflow, /check-windows:\n {4}strategy:/);
  assert.match(workflow, /runner: windows-2025\n {12}arch: x64/);
  assert.match(workflow, /runner: windows-11-vs2026-arm\n {12}arch: arm64/);
  assert.match(workflow, /node-version: 24/);
  assert.match(workflow, /version: 0\.16\.0/);
  assert.match(workflow, /probe Windows native toolchain/);
  assert.match(workflow, /Get-Command clang\.exe/);
  assert.match(workflow, /Get-Command clang\+\+\.exe/);
  assert.match(workflow, /Get-Command rc\.exe/);
  assert.match(workflow, /VersionInfo\.FileVersion/);
  assert.match(workflow, /npm run build:native/);
  assert.match(workflow, /workflow_call:/);
  assert.match(workflow, /if: \(github\.event_name == 'pull_request' && github\.base_ref == 'main'\) \|\| github\.event_name == 'workflow_call'/);
  assert.doesNotMatch(workflow, /matrix\.arch == 'x64'/);
  assert.match(workflow, /npm run package:win/);
});

test("Windows transcription keeps Unicode paths in its native argv", () => {
  const source = readFileSync(new URL("../native/transcribe_win.cpp", import.meta.url), "utf8");
  const build = readFileSync(new URL("../scripts/build-native.mjs", import.meta.url), "utf8");
  assert.match(source, /int wmain\(int argc, wchar_t\*\* argv\)/);
  assert.match(source, /transcribe\(argv\[1\]\)/);
  assert.match(build, /-municode[^\n]*native\/transcribe_win\.cpp/);
});

test("signed Windows packaging verifies every PE payload", () => {
  const script = readFileSync(new URL("../scripts/package-windows.mjs", import.meta.url), "utf8");
  assert.match(script, /const isPe =/);
  assert.match(script, /const expectedMachine =/);
  assert.match(script, /const archive = path\.join\(app, "resources", "app\.asar"\)/);
  assert.match(script, /listPackage/);
  assert.match(script, /Wrong Windows architecture/);
  assert.match(script, /const verifyPeDirectory =/);
  assert.match(script, /const verifyNupkg =/);
  assert.match(script, /inflateRawSync/);
  assert.match(script, /productName: "Emma"/);
  assert.match(script, /for \(const nupkg of nupkgs\) verifyNupkg/);
});

test("draft release validation has the permission GitHub requires to view drafts", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");
  const plan = workflow.match(/^ {2}plan:\n([\s\S]*?)(?=^ {2}\S)/m)?.[1] ?? "";
  assert.match(plan, /^ {4}permissions:\n {6}contents: write$/m);
});

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
