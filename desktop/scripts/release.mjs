import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

export function stableVersion(value) {
  assert.equal(typeof value, "string", "A release needs a stable X.Y.Z version.");
  assert.match(value, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, "A release needs a stable X.Y.Z version.");
  return value;
}

export function checkPullRequest(pr, repository) {
  assert.match(pr.title, /^(feat|fix|perf|refactor|docs|test|build|ci|chore|revert)(\([a-z0-9 ._/-]+\))?!?: \S[^\r\n]*$/, "Use a conventional PR title, for example fix(notch): preserve focus.");
  assert.ok(["dev", "main"].includes(pr.base.ref), "Pull requests must target dev or main.");
  if (pr.base.ref === "main") {
    assert.equal(pr.head.ref, "dev", "Only dev can be promoted to main. Feature PRs target dev.");
    assert.equal(pr.head.repo?.full_name, repository, "Promote this repository's dev branch, not a fork.");
  }
}

export function checkVersionAdvance(version, previous) {
  const next = stableVersion(version).split(".").map(BigInt);
  const base = stableVersion(previous).split(".").map(BigInt);
  const index = next.findIndex((part, i) => part !== base[i]);
  assert.ok(index !== -1 && next[index] > base[index], "Merge the generated release PR into dev before promoting a new version to main.");
}

export function verifyCandidate(cwd = root, ref = "HEAD") {
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const version = stableVersion(JSON.parse(git("show", `${ref}:package.json`)).version);
  const manifest = JSON.parse(git("show", `${ref}:.release-please-manifest.json`));
  assert.equal(manifest["."], version, "The release manifest and package.json must agree.");
  const tag = `v${version}`;
  const commit = git("rev-parse", "--verify", `refs/tags/${tag}^{commit}`);
  git("merge-base", "--is-ancestor", commit, ref);
  assert.equal(git("rev-parse", `${ref}^{tree}`), git("rev-parse", `${commit}^{tree}`), "The release candidate changed after it was tagged. Prepare a new release on dev.");
  return { version, tag };
}

export function releasePlan(candidate, release) {
  assert.equal(release.tagName, candidate.tag, "The GitHub release must match the candidate tag.");
  assert.equal(release.isPrerelease, false, "Main publishes stable releases only.");
  assert.equal(typeof release.isDraft, "boolean", "GitHub did not return a release state.");
  return { ...candidate, publish: release.isDraft };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (command === "pr") {
    const { pull_request: pr } = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    checkPullRequest(pr, process.env.GITHUB_REPOSITORY);
    if (pr.base.ref === "main") {
      const { version } = verifyCandidate();
      assert.match(pr.base.sha, /^[a-f0-9]{40}$/);
      const previous = JSON.parse(execFileSync("git", ["show", `${pr.base.sha}:package.json`], { cwd: root, encoding: "utf8" })).version;
      checkVersionAdvance(version, previous);
    }
  } else if (command === "plan") {
    const candidate = verifyCandidate();
    const release = JSON.parse(execFileSync("gh", ["release", "view", candidate.tag, "--repo", process.env.GITHUB_REPOSITORY, "--json", "tagName,isDraft,isPrerelease"], { encoding: "utf8" }));
    for (const [key, value] of Object.entries(releasePlan(candidate, release))) console.log(`${key}=${value}`);
  } else if (command === "candidate") {
    console.log(JSON.stringify(verifyCandidate()));
  } else {
    throw new Error("Usage: node desktop/scripts/release.mjs pr|plan|candidate");
  }
}
