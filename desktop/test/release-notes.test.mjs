import assert from "node:assert/strict";
import test from "node:test";
import { generateReleaseNotes } from "../scripts/release-notes.mjs";

test("release notes collect the published range, preserve summaries, and include every page", () => {
  const target = "a".repeat(40);
  const commit = (message, index = 1) => ({
    sha: index.toString(16).padStart(40, "0"),
    commit: { message },
    parents: [{}],
    author: { login: "contributor" },
  });
  const changes = [
    { ...commit("Merge pull request #90 from team/dev"), parents: [{}, {}] },
    commit("feat(chat): attach folders (#91)\r\n\r\n## Release notes\r\n- Search attached folders.\r\n- Select which folders to share.\r\n\r\n## Validation\r\nPrivate test details."),
    { ...commit("fix: restore drafts", 2), author: null },
    commit("perf: speed up startup (#92)"),
    commit("docs: explain folder sharing (#93)"),
    commit("feat!: change the storage format (#94)\n\n## Release notes\n- Store attachments beside conversations.\n\nBREAKING CHANGE: Export old archives before upgrading.\nKeep a backup until migration finishes.\n\nCo-authored-by: Someone <private@example.com>"),
    commit("An ordinary commit title", 3),
    commit("constructor: preserve legacy titles"),
    commit("fix(storage): migrate old records\n\nBREAKING-CHANGE: Rebuild the local index."),
    ...Array.from({ length: 260 }, (_, index) => commit(`fix: repair item ${index}`, index + 10)),
  ];
  const requests = [];
  const pages = {
    "repos/team/emma/commits/dev": [{ sha: target }],
    "repos/team/emma/releases?per_page=100": [
      { tag_name: "v3.0.0", draft: true, published_at: "2026-09-04T00:00:00Z" },
      { tag_name: "v2.0.0-beta.1", prerelease: true, published_at: "2026-09-03T00:00:00Z" },
      { tag_name: "v0.9.0", published_at: "2026-08-01T00:00:00Z" },
      { tag_name: "v1.0.0", published_at: "2026-09-02T00:00:00Z" },
    ],
    [`repos/team/emma/compare/v1.0.0...${target}?per_page=100`]: [
      { commits: changes.slice(0, 100) },
      { commits: changes.slice(100, 200) },
      { commits: changes.slice(200) },
    ],
  };
  const notes = generateReleaseNotes("team/emma", {}, (endpoint) => {
    requests.push(endpoint);
    assert.ok(Object.hasOwn(pages, endpoint), endpoint);
    return pages[endpoint];
  });
  assert.equal(requests.length, 3);
  assert.equal((notes.match(/^- /gm) ?? []).length, changes.length - 1);
  assert.match(notes, /^## Breaking changes\n/);
  assert.match(notes, /## Features\n\n- attach folders \(\[#91\]\(https:\/\/github.com\/team\/emma\/pull\/91\)\) by @contributor\n {2}- Search attached folders\.\n {2}- Select which folders to share\./);
  assert.match(notes, /## Fixes\n\n- restore drafts \(\[0000000\]\(https:\/\/github.com\/team\/emma\/commit\/0000000000000000000000000000000000000002\)\)/);
  assert.match(notes, /## Performance\n/);
  assert.match(notes, /## Documentation\n/);
  assert.match(notes, /## Other changes\n\n- An ordinary commit title/);
  assert.match(notes, /preserve legacy titles/);
  assert.match(notes, /repair item 259/);
  assert.match(notes, /\*\*Breaking change:\*\* Export old archives before upgrading\.\n {2}Keep a backup until migration finishes\./);
  assert.ok(notes.indexOf("- migrate old records") < notes.indexOf("## Features"));
  assert.doesNotMatch(notes, /Merge pull request|Private test details|private@example.com|Co-authored-by/);
  assert.match(notes, new RegExp(`https://github.com/team/emma/compare/v1.0.0\\.\\.\\.${target}`));

  const first = generateReleaseNotes("team/emma", {}, (endpoint) => {
    if (endpoint.endsWith("/commits/dev")) return [{ sha: target }];
    if (endpoint.endsWith("/releases?per_page=100")) return [];
    assert.equal(endpoint, `repos/team/emma/commits?sha=${target}&per_page=100`);
    return [commit("feat: second"), commit("feat: first")];
  });
  assert.ok(first.indexOf("- first") < first.indexOf("- second"));
  assert.match(first, /\[All commits\]/);

  const empty = generateReleaseNotes("team/emma", { from: "release/1", to: "feature/next" }, (endpoint) => {
    if (endpoint.endsWith("/commits/feature%2Fnext")) return [{ sha: target }];
    assert.equal(endpoint, `repos/team/emma/compare/release%2F1...${target}?per_page=100`);
    return [{ commits: [] }];
  });
  assert.match(empty, /^No changes since the previous release\./);
  assert.throws(() => generateReleaseNotes("team/emma", {}, () => { throw new Error("GitHub unavailable"); }), /GitHub unavailable/);
});
