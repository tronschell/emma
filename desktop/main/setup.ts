import { homedir } from "node:os";
import path from "node:path";
import { vaultWritable } from "./vault";
import { noteFolder, type VaultChoice } from "../shared/vault";

export function defaultVaultRoot(): string {
  return path.join(homedir(), "Documents");
}

export function vaultNotesDir(vault: VaultChoice | null): string {
  return vault ? noteFolder(vault) : "";
}

export function vaultReady(vault: VaultChoice | null): boolean {
  return !vault || vaultWritable(vault);
}
