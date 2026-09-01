import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolve } from "node:path";
import { isCurrentThreadLoad, threadMessageCount, threadMessageDates, threadUserMessageCount, type Thread } from "../src/types";
import { spawnedAgents, threadLabel, threadTitle } from "../src/threads";

const compact = (over: Partial<Thread> = {}): Thread => ({
  id: "thread-123456789012",
  title: "New thread",
  createdAt: "2026-08-31T10:00:00.000Z",
  updatedAt: "2026-08-31T10:02:00.000Z",
  messages: [],
  ...over,
});

test("compact thread metadata preserves labels, counts, activity and subagent briefs", () => {
  const thread = compact({
    messageCount: 4,
    messageDates: ["2026-08-31T10:00:00.000Z", "2026-08-31T10:02:00.000Z"],
    userMessageCount: 2,
    displayTitle: "what is in this folder",
  });
  assert.equal(threadLabel(thread), "what is in this folder");
  assert.equal(threadMessageCount(thread), 4);
  assert.equal(threadUserMessageCount(thread), 2);
  assert.deepEqual(threadMessageDates(thread), ["2026-08-31T10:00:00.000Z", "2026-08-31T10:02:00.000Z"]);

  const child = compact({ id: "child-123456789012", title: "Iris", kind: "subagent", parentThreadId: thread.id, subagentBrief: "read the docs" });
  assert.equal(spawnedAgents([child], [], thread.id)[0].brief, "read the docs");

  const asked = `${"🙂".repeat(24)}x`;
  assert.equal(threadLabel(compact({ labelPrompt: asked, displayTitle: "wrong" })), asked.length > 48 ? `${asked.slice(0, 47)}…` : asked);
});

test("a thread response from an old selection cannot replace the current selection", () => {
  assert.equal(isCurrentThreadLoad("thread-a-123456", "thread-a-123456"), true);
  assert.equal(isCurrentThreadLoad("thread-a-123456", "thread-b-123456"), false);
  assert.equal(isCurrentThreadLoad("thread-a-123456", "thread-a-123456", "child-a-123456", "child-a-123456"), true);
  assert.equal(isCurrentThreadLoad("thread-a-123456", "thread-a-123456", "child-a-123456", "child-b-123456"), false);
});

test("the quick overlay does not subscribe to the full thread library", () => {
  const source = readFileSync(resolve(__dirname, "../../src/App.tsx"), "utf8");
  const overlay = source.slice(source.indexOf("function Overlay()"));
  assert.doesNotMatch(overlay, /useSnapshot\(\)/);
  assert.doesNotMatch(overlay, /await load\(\)/);
});

test("thread loading remounts fresh selections and refreshes changed subagents", () => {
  const source = readFileSync(resolve(__dirname, "../../src/App.tsx"), "utf8");
  assert.match(source, /view === "threads" \? thread \? <ThreadView key=\{thread\.id\}/);
  assert.match(source, /: <ThreadLoading loading=\{snapshotLoading \|\| !!selectedSummary\}/);
  assert.match(source, /const subagentRevision = `\$\{subagentSummary\?\.updatedAt \?\? ""\}:\$\{subagentSummary \? threadMessageCount\(subagentSummary\) : 0\}`/);
  assert.match(source, /\[loadThread, subagentId, subagentRevision\]/);
  assert.match(source, /selectedIdRef\.current === parentId && currentRequest === requestId/);
  assert.doesNotMatch(source, /if \(!subagentId \|\| loadedSubthread\?\.id === subagentId\) return;/);
});

test("agent tabs wait for their targeted transcript instead of showing a compact summary", () => {
  const source = readFileSync(resolve(__dirname, "../../src/App.tsx"), "utf8");
  assert.match(source, /const subagentLoading = !!subagentId && loadedSubthread\?\.id !== subagentId;/);
  assert.match(source, /const panel = subagentLoading \? <AgentTranscriptLoading error=\{subagentError\}/);
  assert.match(source, /\(\) => subagentId \? loadedSubthread\?\.id === subagentId \? loadedSubthread : undefined : thread/);
});

test("settled rich blocks are cached before the transient run is released", () => {
  const source = readFileSync(resolve(__dirname, "../../src/App.tsx"), "utf8");
  assert.match(source, /useMemo\(\(\) => \{ void run\.landed; return cachedBlocks\(thread\.id\); \}, \[thread\.id, run\.landed\]\)/);
  assert.match(source, /rememberBlocks\(thread\.id, turns\);\s+settleRun\(thread\.id, thread\.messages, cachedBlocks\(thread\.id\)\);/);
});

test("desktop refreshes summaries and keeps targeted reads read-only", () => {
  const app = readFileSync(resolve(__dirname, "../../src/App.tsx"), "utf8");
  const main = readFileSync(resolve(__dirname, "../../main/main.ts"), "utf8");
  assert.match(app, /const SNAPSHOT_REFRESH_MS = 60_000/);
  assert.match(app, /setInterval\(refreshVisible, SNAPSHOT_REFRESH_MS\)/);
  assert.match(main, /if \(request\.method === "thread" \|\| request\.method === "readTrace"\) return this\.send\(request\);/);
  assert.match(main, /new Set\(\["snapshot", "threadSummaries", "thread", "listOpenRouterModels"\]\)/);
});

test("the sidebar filter searches the full name the host sends, not the truncated one", () => {
  const app = readFileSync(resolve(__dirname, "../../src/App.tsx"), "utf8");
  const host = readFileSync(resolve(__dirname, "../../../crates/host/src/main.rs"), "utf8");
  assert.match(app, /group\.threads\.filter\(\(item\) => threadTitle\(item\)\.toLowerCase\(\)\.includes\(search\)/);
  assert.match(host, /\.filter\(\|content\| content\.encode_utf16\(\)\.count\(\) > 48\)\s+\.map\(\|content\| utf16_prefix\(content, SEARCHABLE_TITLE_UNITS\)\)/);
  const buried = "Draft a one page memo for the pricing committee on semiconductor supply";
  assert.equal(threadLabel(compact({ labelPrompt: buried })).includes("semiconductor"), false);
  assert.equal(threadTitle(compact({ labelPrompt: buried })).includes("semiconductor"), true);
});

test("a window takes every store change, frontmost or not, and a mid-turn write is one of them", () => {
  const app = readFileSync(resolve(__dirname, "../../src/App.tsx"), "utf8");
  const main = readFileSync(resolve(__dirname, "../../main/main.ts"), "utf8");
  assert.match(app, /const listener = window\.emma\.onChanged\(refresh\);/);
  assert.doesNotMatch(app, /onChanged\(refreshVisible\)/);
  assert.match(main, /this\.storeChanged\(\);\s+const written = this\.send\(request\);\s+void written\.then\(\(\) => changed\(\), \(\) => undefined\);/);
});

test("a successful refresh clears only the error the refresh itself raised", () => {
  const app = readFileSync(resolve(__dirname, "../../src/App.tsx"), "utf8");
  assert.match(app, /if \(owned\.current\) \{\s+owned\.current = false;\s+setError\(""\);\s+\}/);
  assert.match(app, /owned\.current = true;\s+setError\(reasonText\(reason\)\);/);
  assert.match(app, /const notify = useCallback\(\(text: string\) => \{\s+owned\.current = false;\s+setError\(text\);\s+\}, \[\]\);/);
  assert.match(app, /return \{ snapshot, load, error, setError: notify, revision, loading: !loaded \};/);
});
