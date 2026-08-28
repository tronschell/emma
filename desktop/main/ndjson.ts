import { Buffer } from "node:buffer";
import { withThinking } from "../shared/thinking";

export class BoundedLines {
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });

  constructor(private readonly maxBytes: number) {}

  push(value: Uint8Array) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const lines: string[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      const piece = chunk.subarray(offset, end);
      if (this.pendingBytes + piece.length > this.maxBytes) throw new Error("Host response line is too large");
      if (newline < 0) {
        this.pending.push(Buffer.from(piece));
        this.pendingBytes += piece.length;
        break;
      }
      const line = this.pendingBytes ? Buffer.concat([...this.pending, piece], this.pendingBytes + piece.length) : piece;
      this.pending = [];
      this.pendingBytes = 0;
      lines.push(this.decoder.decode(line));
      offset = end + 1;
    }
    return lines;
  }

  end() {
    if (this.pendingBytes) throw new Error("Host response ended mid-line");
  }
}

export const MAX_RECORDED_TURN_BYTES = 120 * 1024;

export type RecordedTurn = {
  threadId: string;
  prompt: string;
  thinking?: string;
  answer: string;
  durationMilliseconds: string;
  outputTokens: string;
  inputTokens: string;
  model: string;
};

export function elided(text: string, room: number): string {
  if (text.length <= room) return text;
  const half = Math.max(0, (room - 48) >> 1);
  const head = text.slice(0, half).replace(/[\uD800-\uDBFF]$/, "");
  const tail = text.slice(text.length - half).replace(/^[\uDC00-\uDFFF]/, "");
  return `${head}\n\n… ${text.length - head.length - tail.length} characters elided …\n\n${tail}`;
}

export function recordedTurn({ thinking, answer, ...rest }: RecordedTurn): Record<string, string> {
  const fitted = (room: number) => ({
    ...rest,
    prompt: elided(rest.prompt, room),
    response: withThinking(elided(thinking ?? "", room), elided(answer, room)),
  });
  const sized = (params: Record<string, string>) => Buffer.byteLength(JSON.stringify(params));
  let room = MAX_RECORDED_TURN_BYTES;
  let params = fitted(room);
  for (let size = sized(params); size > MAX_RECORDED_TURN_BYTES && room > 512; size = sized(params)) {
    room = Math.floor((room * MAX_RECORDED_TURN_BYTES * 0.9) / size);
    params = fitted(room);
  }
  return params;
}

export type HostResponse = { id: string; ok: true; result: unknown } | { id: string; ok: false; error: string };

/// A scheduled job the host just fired — by the clock, by hand, or because the job
/// upstream of it finished — with its thread already saved. Pushed rather than
/// replied to, and carrying the mode the job was saved with, the graph to walk and
/// the variables to walk it with, because all of that runs in this process.
export type HostDueJob = { dueJob: { jobId: string; threadId: string; title: string; prompt: string; nodes: string; variables: string; permissionMode: string; model: string; depth: number } };

const DUE_JOB_FIELDS = ["jobId", "threadId", "title", "prompt", "nodes", "variables", "permissionMode", "model"] as const;

export function parseHostLine(line: string): HostResponse | HostDueJob {
  const value: unknown = JSON.parse(line);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid host response");
  const response = value as Record<string, unknown>;
  if (Object.hasOwn(response, "dueJob")) {
    const job = response.dueJob as Record<string, unknown>;
    if (!job || typeof job !== "object" || typeof job.depth !== "number" || DUE_JOB_FIELDS.some((field) => typeof job[field] !== "string")) {
      throw new Error("Invalid host due job envelope");
    }
    return { dueJob: job as unknown as HostDueJob["dueJob"] };
  }
  if (typeof response.id !== "string" || typeof response.ok !== "boolean") throw new Error("Invalid host response");
  if (response.ok) {
    if (!Object.hasOwn(response, "result")) throw new Error("Invalid host response envelope");
    return { id: response.id, ok: true, result: response.result };
  }
  if (typeof response.error !== "string") throw new Error("Invalid host response envelope");
  return { id: response.id, ok: false, error: response.error };
}
