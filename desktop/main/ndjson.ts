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

export function parseHostResponse(line: string): HostResponse {
  const value: unknown = JSON.parse(line);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid host response");
  const response = value as Record<string, unknown>;
  if (typeof response.id !== "string" || typeof response.ok !== "boolean") throw new Error("Invalid host response");
  if (response.ok) {
    if (!Object.hasOwn(response, "result")) throw new Error("Invalid host response envelope");
    return { id: response.id, ok: true, result: response.result };
  }
  if (typeof response.error !== "string") throw new Error("Invalid host response envelope");
  return { id: response.id, ok: false, error: response.error };
}
