import { safeStorage } from "electron";
import { Buffer } from "node:buffer";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isEnvName, MAX_SECRET_CHARS, maskSecret, printableSecret, SECURE_STORE_BROKEN } from "../shared/settings";

export type CredentialSummary = { env: string; masked: string; readable: boolean };

export function secureStoreWorks(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  try { return safeStorage.decryptString(safeStorage.encryptString("emma")) === "emma"; }
  catch { return false; }
}

export class CredentialStore {
  private readonly file: string;
  private secrets = new Map<string, string>();
  private unreadable = new Map<string, string>();
  private applied = new Set<string>();

  constructor(userData: string) {
    this.file = path.join(userData, "credentials.json");
    this.load();
  }

  list(): CredentialSummary[] {
    const readable = [...this.secrets].map(([env, secret]) => ({ env, masked: maskSecret(secret), readable: true }));
    const lost = [...this.unreadable.keys()].map((env) => ({ env, masked: "", readable: false }));
    return [...readable, ...lost].sort((left, right) => left.env.localeCompare(right.env));
  }

  set(env: string, secret: string): void {
    const value = secret.trim();
    if (!isEnvName(env)) throw new Error("An environment variable name must start with a letter or underscore and hold only letters, digits, and underscores.");
    if (!value || value.length > MAX_SECRET_CHARS) throw new Error(`Paste a key of 1 to ${MAX_SECRET_CHARS} characters.`);
    if (!printableSecret(value)) throw new Error("A key holds printable ASCII only; check for a stray space or newline.");
    this.unreadable.delete(env);
    this.secrets.set(env, value);
    this.save();
  }

  remove(env: string): void {
    if (this.secrets.delete(env) || this.unreadable.delete(env)) this.save();
  }

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
    let stored: Record<string, unknown>;
    try { stored = JSON.parse(raw) as Record<string, unknown>; }
    catch (error) {
      console.error("Emma: the stored provider keys are not readable JSON, so they are left on disk untouched", error);
      return;
    }
    const working = secureStoreWorks();
    if (!working) console.error(`Emma: ${SECURE_STORE_BROKEN}`);
    for (const [env, value] of Object.entries(stored)) {
      if (!isEnvName(env) || typeof value !== "string") continue;
      if (!working) { this.unreadable.set(env, value); continue; }
      try { this.secrets.set(env, safeStorage.decryptString(Buffer.from(value, "base64"))); }
      catch { this.unreadable.set(env, value); }
    }
    if (this.unreadable.size) console.error(`Emma: these stored provider keys could not be read on this computer and are kept on disk until you replace or remove them: ${[...this.unreadable.keys()].join(", ")}`);
  }

  private save() {
    if (!secureStoreWorks()) throw new Error(SECURE_STORE_BROKEN);
    const kept = [...this.unreadable];
    const fresh = [...this.secrets].map(([env, secret]) => [env, safeStorage.encryptString(secret).toString("base64")] as [string, string]);
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(Object.fromEntries([...kept, ...fresh]), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.file);
  }
}
