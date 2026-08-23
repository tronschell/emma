import { Buffer } from "node:buffer";

export class BoundedLines {
  private pending = Buffer.alloc(0);
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });

  constructor(private readonly maxBytes: number) {}

  push(value: Uint8Array) {
    const chunk = Buffer.from(value);
    const lines: string[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      const piece = chunk.subarray(offset, end);
      if (this.pending.length + piece.length > this.maxBytes) throw new Error("Host response line is too large");
      if (newline < 0) {
        this.pending = this.pending.length ? Buffer.concat([this.pending, piece]) : Buffer.from(piece);
        break;
      }
      const line = this.pending.length ? Buffer.concat([this.pending, piece]) : piece;
      this.pending = Buffer.alloc(0);
      lines.push(this.decoder.decode(line));
      offset = end + 1;
    }
    return lines;
  }

  end() {
    if (this.pending.length) throw new Error("Host response ended mid-line");
  }
}

export type HostResponse = { id: string; ok: true; result: unknown } | { id: string; ok: false; error: string };

/// Assistant text streamed while the turn that produces it is still in flight.
/// Tagged by thread rather than request ID: it resolves nothing, and the window
/// that has to render it is chosen by thread anyway.
export type HostDelta = { threadId: string; delta: string };

/// A scheduled job the host just fired — by the clock, by hand, or because the job
/// upstream of it finished — with its thread already saved. Pushed rather than
/// replied to, and carrying the mode the job was saved with, the graph to walk and
/// the variables to walk it with, because all of that runs in this process.
export type HostDueJob = { dueJob: { jobId: string; threadId: string; title: string; prompt: string; nodes: string; variables: string; permissionMode: string; depth: number } };

const DUE_JOB_FIELDS = ["jobId", "threadId", "title", "prompt", "nodes", "variables", "permissionMode"] as const;

export function parseHostLine(line: string): HostResponse | HostDelta | HostDueJob {
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
  if (typeof response.threadId === "string") {
    if (typeof response.delta !== "string") throw new Error("Invalid host delta envelope");
    return { threadId: response.threadId, delta: response.delta };
  }
  if (typeof response.id !== "string" || typeof response.ok !== "boolean") throw new Error("Invalid host response");
  if (response.ok) {
    if (!Object.hasOwn(response, "result")) throw new Error("Invalid host response envelope");
    return { id: response.id, ok: true, result: response.result };
  }
  if (typeof response.error !== "string") throw new Error("Invalid host response envelope");
  return { id: response.id, ok: false, error: response.error };
}
