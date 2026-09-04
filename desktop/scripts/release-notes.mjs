import { execFileSync } from "node:child_process";

function github(endpoint) {
  return JSON.parse(execFileSync("gh", ["api", "--paginate", "--slurp", endpoint], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })).flat();
}

export function generateReleaseNotes(repository, { from, to = "dev" } = {}, request = github) {
  const api = `repos/${repository}`;
  const [{ sha: target }] = request(`${api}/commits/${encodeURIComponent(to)}`);
  const previous = from ?? request(`${api}/releases?per_page=100`)
    .filter((release) => !release.draft && !release.prerelease && release.published_at)
    .sort((a, b) => b.published_at.localeCompare(a.published_at))[0]?.tag_name;
  const commits = previous
    ? request(`${api}/compare/${encodeURIComponent(previous)}...${target}?per_page=100`).flatMap((page) => page.commits)
    : request(`${api}/commits?sha=${target}&per_page=100`).toReversed();
  const sections = new Map(["Breaking changes", "Features", "Fixes", "Performance", "Documentation", "Other changes"].map((name) => [name, []]));
  const categories = new Map([["feat", "Features"], ["fix", "Fixes"], ["perf", "Performance"], ["docs", "Documentation"]]);
  const url = `https://github.com/${repository}`;

  for (const commit of commits) {
    if (commit.parents.length > 1) continue;
    const message = commit.commit.message.replaceAll("\r\n", "\n");
    const subject = message.split("\n")[0];
    const pr = subject.match(/ \(#(\d+)\)$/)?.[1];
    const summary = subject.replace(/ \(#\d+\)$/, "");
    const conventional = summary.match(/^([a-z]+)(?:\([^)]+\))?(!)?:\s*(.+)$/i);
    const title = conventional?.[3] ?? summary;
    const notes = message.split(/^## Release notes[ \t]*$/im)[1]
      ?.split(/^(?:#{1,2}\s|BREAKING[ -]CHANGE:|Co-authored-by:|Signed-off-by:)/im)[0].trim();
    const breaking = message.split(/^BREAKING[ -]CHANGE:[ \t]*/m)[1]
      ?.split(/^(?:#{1,2}\s|Co-authored-by:|Signed-off-by:)/im)[0].trim();
    const category = conventional?.[2] || breaking ? "Breaking changes" : categories.get(conventional?.[1].toLowerCase()) ?? "Other changes";
    const link = pr ? `[#${pr}](${url}/pull/${pr})` : `[${commit.sha.slice(0, 7)}](${url}/commit/${commit.sha})`;
    const author = commit.author?.login ? ` by @${commit.author.login}` : "";
    const details = [notes, breaking && `**Breaking change:** ${breaking}`].filter(Boolean).join("\n\n");
    sections.get(category).push(`- ${title} (${link})${author}${details ? `\n${details.split("\n").map((line) => `  ${line}`).join("\n")}` : ""}`);
  }

  const body = [...sections].filter(([, entries]) => entries.length)
    .map(([name, entries]) => `## ${name}\n\n${entries.join("\n")}`).join("\n\n");
  const comparison = previous
    ? `[${previous}…${target.slice(0, 7)}](${url}/compare/${encodeURIComponent(previous)}...${target})`
    : `[All commits](${url}/commits/${target})`;
  return `${body || "No changes since the previous release."}\n\n**Full changelog:** ${comparison}\n`;
}

if (import.meta.main) {
  const repository = process.env.GITHUB_REPOSITORY ?? execFileSync("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], { encoding: "utf8" }).trim();
  process.stdout.write(generateReleaseNotes(repository, { from: process.argv[2], to: process.argv[3] ?? process.env.GITHUB_SHA ?? "dev" }));
}
