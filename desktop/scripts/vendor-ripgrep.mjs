import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const VERSION = "15.2.0";
const ARCHIVES = {
  arm64: { target: "aarch64-apple-darwin", sha256: "3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4" },
  x64: { target: "x86_64-apple-darwin", sha256: "af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1" },
};

const vendor = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "vendor");
const binary = path.join(vendor, "rg");
const stamp = path.join(vendor, "rg.version");
const want = `ripgrep ${VERSION} ${process.arch}\n`;
const files = ["rg", "COPYING", "LICENSE-MIT", "UNLICENSE"];

if (files.every((name) => existsSync(path.join(vendor, name))) && existsSync(stamp) && readFileSync(stamp, "utf8") === want) {
  console.log(`ripgrep ${VERSION} already vendored.`);
  process.exit(0);
}

const archive = process.platform === "darwin" ? ARCHIVES[process.arch] : undefined;
if (!archive) {
  console.warn(`No pinned ripgrep for ${process.platform}/${process.arch}; Emma will use the rg or grep already on this machine.`);
  process.exit(0);
}

const name = `ripgrep-${VERSION}-${archive.target}`;
const url = `https://github.com/BurntSushi/ripgrep/releases/download/${VERSION}/${name}.tar.gz`;
console.log(`Fetching ${url}`);
const response = await fetch(url);
if (!response.ok) throw new Error(`ripgrep download failed: ${response.status} ${response.statusText}`);
const bytes = Buffer.from(await response.arrayBuffer());

const digest = createHash("sha256").update(bytes).digest("hex");
if (digest !== archive.sha256) throw new Error(`ripgrep checksum mismatch: expected ${archive.sha256}, got ${digest}. Nothing was written.`);

mkdirSync(vendor, { recursive: true });
const tarball = path.join(vendor, `${name}.tar.gz`);
writeFileSync(tarball, bytes);
try {
  execFileSync("tar", ["-xzf", tarball, "-C", vendor, "--strip-components=1", ...files.map((file) => `${name}/${file}`)]);
} finally {
  rmSync(tarball, { force: true });
}
chmodSync(binary, 0o755);
writeFileSync(stamp, want);
console.log(`Vendored ${execFileSync(binary, ["--version"]).toString().split("\n")[0]} to ${binary}`);
