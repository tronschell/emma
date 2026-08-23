import { safeStorage } from "electron";
import { Buffer } from "node:buffer";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isEnvName, MAX_SECRET_CHARS, maskSecret, printableSecret } from "../shared/settings";

export type CredentialSummary = { env: string; masked: string };

/**
 * Provider keys the user pastes in Settings. Main and the harness read credentials from
 * their environment, so the plaintext lives here and reaches them only through this
 * process's env — it is never returned to the renderer, only its mask.
 *
 * Reads and writes are synchronous because the env has to be complete before anything spawns.
 */
export class CredentialStore {
  private readonly file: string;
  private secrets = new Map<string, string>();
  private applied = new Set<string>();

  constructor(userData: string) {
    this.file = path.join(userData, "credentials.json");
    this.load();
  }

  list(): CredentialSummary[] {
    return [...this.secrets].map(([env, secret]) => ({ env, masked: maskSecret(secret) })).sort((left, right) => left.env.localeCompare(right.env));
  }

  set(env: string, secret: string): void {
    const value = secret.trim();
    if (!isEnvName(env)) throw new Error("An environment variable name must start with a letter or underscore and hold only letters, digits, and underscores.");
    if (!value || value.length > MAX_SECRET_CHARS) throw new Error(`Paste a key of 1 to ${MAX_SECRET_CHARS} characters.`);
    if (!printableSecret(value)) throw new Error("A key holds printable ASCII only; check for a stray space or newline.");
    this.secrets.set(env, value);
    this.save();
  }

  remove(env: string): void {
    if (this.secrets.delete(env)) this.save();
  }

  /** Mirrors the stored keys into `env`, clearing names this store set on an earlier pass. */
  applyToEnv(env: NodeJS.ProcessEnv): void {
    for (const name of this.applied) if (!this.secrets.has(name)) delete env[name];
    this.applied.clear();
    for (const [name, secret] of this.secrets) {
      env[name] = secret;
      this.applied.add(name);
    }
  }

  private load() {
    let raw: string;
    try { raw = readFileSync(this.file, "utf8"); } catch { return; }
    try {
      const stored = JSON.parse(raw) as Record<string, unknown>;
      for (const [env, value] of Object.entries(stored)) {
        if (!isEnvName(env) || typeof value !== "string") continue;
        this.secrets.set(env, safeStorage.decryptString(Buffer.from(value, "base64")));
      }
    } catch (error) {
      console.error("Emma: stored provider keys could not be read; re-enter them in Settings", error);
      this.secrets.clear();
    }
  }

  private save() {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("This Mac's keychain is unavailable, so Emma will not store a key in plain text.");
    const stored = Object.fromEntries([...this.secrets].map(([env, secret]) => [env, safeStorage.encryptString(secret).toString("base64")]));
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(stored, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.file);
  }
}
