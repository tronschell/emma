/* Puts a ripgrep binary in desktop/vendor/rg, which is what the app bundles and
   what the `ripgrep` tool runs. Pinned by version *and* by the SHA-256 the
   release publishes: this downloads an executable, so the hash is the check that
   what arrived is what BurntSushi built. Already there and unchanged: does
   nothing, so it is cheap to run before every build. */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const VERSION = "14.1.1";
const ARCHIVES = {
  arm64: { target: "aarch64-apple-darwin", sha256: "24ad76777745fbff131c8fbc466742b011f925bfa4fffa2ded6def23b5b937be" },
  x64: { target: "x86_64-apple-darwin", sha256: "fc87e78f7cb3fea12d69072e7ef3b21509754717b746368fd40d88963630e2b3" },
};

const vendor = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "vendor");
const binary = path.join(vendor, "rg");
const stamp = path.join(vendor, "rg.version");
const want = `ripgrep ${VERSION} ${process.arch}\n`;

if (existsSync(binary) && existsSync(stamp) && readFileSync(stamp, "utf8") === want) {
  console.log(`ripgrep ${VERSION} already vendored.`);
  process.exit(0);
}

const archive = process.platform === "darwin" ? ARCHIVES[process.arch] : undefined;
if (!archive) {
  // Not fatal: the tool falls back to the PATH's rg, then to grep.
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
  execFileSync("tar", ["-xzf", tarball, "-C", vendor, "--strip-components=1", `${name}/rg`]);
} finally {
  rmSync(tarball, { force: true });
}
chmodSync(binary, 0o755);
writeFileSync(stamp, want);
console.log(`Vendored ${execFileSync(binary, ["--version"]).toString().split("\n")[0]} to ${binary}`);
