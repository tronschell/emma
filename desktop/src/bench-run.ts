import { runArms, runExpected } from "../shared/bench";
import { readTurn, type Arm } from "../shared/improvement";
import { setThreadFolders, setThreadMode } from "./context";
import type { BenchCase, BenchResult, BenchRun } from "../shared/bench";
import type { FolderGrant } from "../shared/folders";
import type { PermissionMode } from "../shared/permissions";
import type { Thread } from "./types";

export type BenchProgress = { runId: string; done: number; total: number; caseTitle: string; arm: Arm };

const TRACE_RETRY_MS = 250;

let running = "";
let live = "";

export function benchLive(): string {
  return running;
}

export function stopBench() {
  const thread = live;
  running = "";
  live = "";
  if (thread) window.emma.stopAgent(thread);
}

export function benchBlocker(cases: readonly BenchCase[], mode: string, folders: readonly FolderGrant[]): string {
  if (mode === "ask") return "The bench cannot run in Ask mode, where your own Allow answers would become the measurement.";
  const missing = cases.filter((item) => !folders.some((grant) => grant.id === item.folderId)).length;
  if (missing) return `${missing} of ${cases.length} cases point at a folder that is no longer connected.`;
  return "";
}

const tick = () => new Promise<void>((resolve) => { setTimeout(resolve, TRACE_RETRY_MS); });

export function benchKin(threads: readonly Thread[], roots: readonly string[]): Set<string> {
  const found = new Set(roots);
  for (let again = true; again;) {
    again = false;
    for (const item of threads) {
      if (found.has(item.id) || !item.parentThreadId || !found.has(item.parentThreadId)) continue;
      found.add(item.id);
      again = true;
    }
  }
  return found;
}

export function containBench(roots: readonly string[]): void {
  for (const root of roots) window.emma.stopAgent(root);
}

async function driveCase(run: BenchRun, item: BenchCase, arm: Arm, onThread: (runId: string, threadId: string) => void, onResult: (runId: string, result: BenchResult) => void) {
  const thread = await window.emma.request<Thread>("createThread");
  live = thread.id;
  onThread(run.id, thread.id);
  try {
    await window.emma.request("setThreadArchived", { threadId: thread.id, archived: "true" });
    if (benchLive() !== run.id) return;
    await window.emma.request("renameThread", { threadId: thread.id, title: `Bench · ${item.title}`.slice(0, 120) });
    if (benchLive() !== run.id) return;
    setThreadFolders(thread.id, [item.folderId]);
    setThreadMode(thread.id, run.mode as PermissionMode);
    await window.emma.setThreadContext({ threadId: thread.id, folderIds: [item.folderId], mode: run.mode as PermissionMode, model: run.model });
    if (benchLive() !== run.id) return;
    await window.emma.forceArm({ threadId: thread.id, arm });
    if (benchLive() !== run.id) return;
    let hard = false;
    try { await window.emma.request("sendMessage", { threadId: thread.id, content: item.prompt }); }
    catch { hard = true; }
    if (benchLive() !== run.id) return;
    let traces = await window.emma.threadTraces(thread.id);
    if (!traces.length) { await tick(); traces = await window.emma.threadTraces(thread.id); }
    const trace = traces.at(-1);
    if (!trace || benchLive() !== run.id) return;
    const turn = readTurn(trace, { id: thread.id, title: item.title });
    if (turn.arm !== arm) return;
    onResult(run.id, { caseId: item.id, arm, failures: turn.failures, blocks: turn.blocks, steps: turn.steps, failed: turn.ok && !hard ? 0 : 1 });
  } finally {
    if (live === thread.id) live = "";
    containBench([thread.id]);
  }
}

export async function driveBench(input: {
  run: BenchRun;
  cases: readonly BenchCase[];
  onThread: (runId: string, threadId: string) => void;
  onResult: (runId: string, result: BenchResult) => void;
  onProgress: (progress: BenchProgress | null) => void;
}): Promise<void> {
  const { run, cases, onThread, onResult, onProgress } = input;
  const blocker = benchBlocker(cases, run.mode, await window.emma.listFolders().catch(() => []));
  if (blocker) throw new Error(blocker);
  const arms: Arm[] = runArms(run) === 2 ? ["a", "b"] : ["a"];
  const total = runExpected(run);
  running = run.id;
  let done = 0;
  try {
    for (const item of cases) {
      for (const arm of arms) {
        if (benchLive() !== run.id) return;
        const grants = await window.emma.listFolders().catch(() => []);
        if (benchLive() !== run.id) return;
        if (!grants.some((grant) => grant.id === item.folderId)) throw new Error(`The folder for ${item.title} was disconnected mid-run.`);
        onProgress({ runId: run.id, done, total, caseTitle: item.title, arm });
        await driveCase(run, item, arm, onThread, onResult);
        done += 1;
      }
    }
  } finally {
    if (running === run.id) running = "";
    onProgress(null);
  }
}
