/* Files the user hands the composer: dropped, pasted, or chosen in the native
   dialog. They are not knowledge and not a folder grant — they belong to one
   message, and the turn carries their text (or, for a picture, their path).

   The renderer names an attachment by id and never by path, the same rule folder
   grants follow: a picked file keeps the path the dialog returned, and dropped or
   pasted bytes are written under userData, because a drop hands the renderer the
   contents and never the path. Either way main is the only side that knows where
   the file is, and `holds` is what lets the vision tool look at one. */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MAX_FILE_BYTES } from "../shared/folders";

/** What the composer shows for one attached file. The path stays main-side. */
export type Attachment = { id: string; name: string; path: string };

/** Pictures are sent as a path for the vision tool, so this is what `nativeImage` can open. */
const IMAGE_FILE = /\.(png|jpe?g|gif|bmp)$/i;
/** A screenshot at retina scale is a couple of megabytes; a photo from a phone is more. */
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
/** Copies of dropped files, swept after a week — a message that old has been sent. */
const KEEP_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;

export const isImageAttachment = (name: string) => IMAGE_FILE.test(name);

/** One path segment, so a name off a drop cannot walk anywhere. */
function safeName(value: unknown): string {
  const name = typeof value === "string" ? path.basename(value).replace(/[/\\]/g, "").trim() : "";
  if (!name || name.startsWith(".") || name.length > 128) throw new Error("That file name cannot be attached.");
  return name;
}

export class AttachmentStore {
  private readonly directory: string;
  private readonly index: string;
  private readonly held = new Map<string, Attachment>();

  /* The index is what survives a relaunch. Without it every attachment in an
     open thread became un-openable the moment Emma restarted: `holds` is the
     only thing that says the user chose this file, and it lived in memory. */
  constructor(userData: string) {
    this.directory = path.join(userData, "attachments");
    this.index = path.join(this.directory, "held.json");
    try {
      const stored = JSON.parse(readFileSync(this.index, "utf8")) as unknown;
      if (Array.isArray(stored)) {
        for (const item of stored as Attachment[]) {
          // A swept copy, or a picked file the user has since moved: forgotten
          // rather than kept as a path that opens nothing.
          if (!item || typeof item.id !== "string" || typeof item.name !== "string" || typeof item.path !== "string") continue;
          if (existsSync(item.path)) this.held.set(item.id, { id: item.id, name: item.name, path: item.path });
        }
      }
    } catch { /* no index yet, or one written by a half-finished write */ }
  }

  /** A file the user chose in the native dialog: read where it already is. */
  hold(file: string): Attachment {
    const full = realpathSync(file);
    const stats = statSync(full);
    if (!stats.isFile()) throw new Error("That is not a file.");
    const name = path.basename(full);
    this.check(name, stats.size);
    const attachment = { id: randomUUID(), name, path: full };
    this.held.set(attachment.id, attachment);
    this.remember();
    return attachment;
  }

  /** Bytes dropped or pasted into the composer, written where the tools can reach them. */
  save(rawName: unknown, data: Uint8Array): Attachment {
    const name = safeName(rawName);
    this.check(name, data.byteLength);
    const id = randomUUID();
    mkdirSync(this.directory, { recursive: true });
    this.sweep();
    const full = path.join(this.directory, `${id}-${name}`);
    writeFileSync(full, data);
    const attachment = { id, name, path: full };
    this.held.set(id, attachment);
    this.remember();
    return attachment;
  }

  /** What the turn carries: a text file's contents, or a picture's path to look at. */
  read(id: unknown): Attachment & { text?: string } {
    const attachment = typeof id === "string" ? this.held.get(id) : undefined;
    if (!attachment) throw new Error("That attachment is no longer held.");
    if (isImageAttachment(attachment.name)) return { ...attachment };
    if (statSync(attachment.path).size > MAX_FILE_BYTES) throw new Error(`${attachment.name} is larger than an attachment can carry.`);
    const bytes = readFileSync(attachment.path);
    // Extensions run out — a Makefile, a .env, a file with none at all — so what
    // decides is whether the bytes read as text at all.
    if (bytes.includes(0)) throw new Error(`${attachment.name} is not a text file, so there is nothing to attach.`);
    return { ...attachment, text: bytes.toString("utf8") };
  }

  /** Whether the model may look at this path: it may, if the user attached it.
      The same question the preview and the editor doors ask before a bare path. */
  holds(file: string): boolean {
    for (const attachment of this.held.values()) if (attachment.path === file) return true;
    return false;
  }

  private check(name: string, bytes: number) {
    const max = isImageAttachment(name) ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
    if (bytes > max) throw new Error(`${name} is ${Math.round(bytes / 1024)} KB; attachments stop at ${Math.round(max / 1024)} KB.`);
  }

  private remember() {
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const temporary = `${this.index}.tmp`;
      writeFileSync(temporary, `${JSON.stringify([...this.held.values()], null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(temporary, this.index);
    } catch { /* the attachment is held for this launch either way */ }
  }

  /** ponytail: age, not a count. A quota only matters if someone attaches gigabytes in a week. */
  private sweep() {
    const stale = Date.now() - KEEP_MILLISECONDS;
    for (const entry of readdirSync(this.directory)) {
      if (entry === path.basename(this.index)) continue;
      const full = path.join(this.directory, entry);
      try { if (statSync(full).mtimeMs < stale) rmSync(full, { force: true }); } catch { /* raced with another sweep */ }
    }
  }
}
