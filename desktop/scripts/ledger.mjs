import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const DEFAULT_DIR = path.join(os.homedir(), "Library", "Application Support", "Emma", "threads");

const parse = (line) => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

export function tracesOf(markdown) {
  const found = [];
  const lines = markdown.split("\n");
  for (let at = 0; at < lines.length; at += 1) {
    if (!/^## Trace \d+$/.test(lines[at])) continue;
    const timestamp = lines.slice(at + 1, at + 4).find((line) => line.startsWith("Time: "))?.slice(6).trim() ?? "";
    const quoted = lines.slice(at + 1, at + 6).find((line) => line.startsWith('"'));
    const text = quoted === undefined ? "" : parse(quoted);
    if (typeof text === "string" && text) found.push({ timestamp, text });
  }
  return found;
}

export function turnOf(trace, thread) {
  const rows = trace.text.split("\n").map(parse).filter((row) => row && typeof row === "object");
  const header = typeof rows[0]?.id === "string" ? {} : { ...(rows[0] ?? {}) };
  delete header.v;
  const spans = rows.filter((row) => typeof row.id === "string" && typeof row.startedAt === "number");
  const calls = spans.filter((span) => span.kind !== "agent" && span.kind !== "model");
  return {
    ...header,
    thread: header.thread || thread,
    at: trace.timestamp,
    failures: calls.filter((span) => span.kind !== "verifier" && span.status === "failed").length,
    blocks: calls.filter((span) => span.kind === "verifier" && span.status === "failed").length,
    steps: calls.filter((span) => span.kind !== "verifier").length,
    ok: !spans.some((span) => span.kind === "agent" && span.status === "failed"),
  };
}

export function ledgerOf(directory) {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".md"))
    .flatMap((name) => tracesOf(readFileSync(path.join(directory, name), "utf8")).map((trace) => turnOf(trace, name.replace(/\.md$/, ""))))
    .sort((left, right) => String(left.at).localeCompare(String(right.at)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const directory = process.env.EMMA_DATA_DIR ? path.join(process.env.EMMA_DATA_DIR, "threads") : DEFAULT_DIR;
  for (const turn of ledgerOf(directory)) console.log(JSON.stringify(turn));
}
