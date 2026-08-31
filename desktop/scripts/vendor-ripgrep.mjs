import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const VERSION = "15.2.0";
const ARCHIVES = {
  darwin: {
    arm64: { target: "aarch64-apple-darwin", sha256: "3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4", extension: "tar.gz" },
    x64: { target: "x86_64-apple-darwin", sha256: "af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1", extension: "tar.gz" },
  },
  win32: {
    arm64: { target: "aarch64-pc-windows-msvc", sha256: "e4abca10c3a64ebea742667dd7009449d49403db5460dd6873e389fa2945360f", extension: "zip" },
    x64: { target: "x86_64-pc-windows-msvc", sha256: "71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5", extension: "zip" },
  },
};

const vendor = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "vendor");
const executable = process.platform === "win32" ? "rg.exe" : "rg";
const binary = path.join(vendor, executable);
const stamp = path.join(vendor, "rg.version");
const archive = ARCHIVES[process.platform]?.[process.arch];
const want = `ripgrep ${VERSION} ${process.platform} ${process.arch}\n`;
const files = [executable, "COPYING", "LICENSE-MIT", "UNLICENSE"];

if (files.every((name) => existsSync(path.join(vendor, name))) && existsSync(stamp) && readFileSync(stamp, "utf8") === want) {
  console.log(`ripgrep ${VERSION} already vendored.`);
  process.exit(0);
}

if (!archive) {
  console.warn(`No pinned ripgrep for ${process.platform}/${process.arch}; Emma will use the rg or grep already on this machine.`);
  process.exit(0);
}

const name = `ripgrep-${VERSION}-${archive.target}`;
const url = `https://github.com/BurntSushi/ripgrep/releases/download/${VERSION}/${name}.${archive.extension}`;
console.log(`Fetching ${url}`);
const response = await fetch(url);
if (!response.ok) throw new Error(`ripgrep download failed: ${response.status} ${response.statusText}`);
const bytes = Buffer.from(await response.arrayBuffer());

const digest = createHash("sha256").update(bytes).digest("hex");
if (digest !== archive.sha256) throw new Error(`ripgrep checksum mismatch: expected ${archive.sha256}, got ${digest}. Nothing was written.`);

mkdirSync(vendor, { recursive: true });
const archivePath = path.join(vendor, `${name}.${archive.extension}`);
writeFileSync(archivePath, bytes);
try {
  const members = files.map((file) => `${name}/${file}`);
  execFileSync("tar", archive.extension === "zip" ? ["-xf", archivePath, "-C", vendor, "--strip-components=1", ...members] : ["-xzf", archivePath, "-C", vendor, "--strip-components=1", ...members]);
} finally {
  rmSync(archivePath, { force: true });
}
if (process.platform !== "win32") chmodSync(binary, 0o755);
writeFileSync(stamp, want);
console.log(`Vendored ${execFileSync(binary, ["--version"]).toString().split("\n")[0]} to ${binary}`);
