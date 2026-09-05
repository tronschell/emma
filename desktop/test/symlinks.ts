import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let allowed: boolean | undefined;

export const NO_SYMLINKS = "Windows denies symlinks without Developer Mode or an elevated shell";

export function symlinksAllowed(): boolean {
  if (allowed !== undefined) return allowed;
  const probe = mkdtempSync(path.join(tmpdir(), "emma-symlink-probe-"));
  try {
    symlinkSync(path.join(probe, "target"), path.join(probe, "link"));
    allowed = true;
  } catch {
    allowed = false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
  return allowed;
}
