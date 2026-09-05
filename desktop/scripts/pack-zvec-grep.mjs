import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.join(scripts, "..");
const out = path.resolve(process.argv[2] ?? path.join(desktop, "release", "tools"));

execFileSync(process.execPath, [path.join(scripts, "vendor-zvec-grep.mjs")], { stdio: "inherit" });

const vendor = path.join(desktop, "vendor", "zvec-grep");
const [, version, platform, arch] = readFileSync(path.join(vendor, "zvec-grep.version"), "utf8").trim().split(" ");
const asset = `zvec-grep-${version}-${platform}-${arch}.tar.gz`;
const tarball = path.join(out, asset);
mkdirSync(out, { recursive: true });
execFileSync("tar", ["-czf", tarball, "-C", vendor, "."], { stdio: "inherit" });

const hash = createHash("sha256");
for await (const chunk of createReadStream(tarball)) hash.update(chunk);
const digest = hash.digest("hex");
writeFileSync(`${tarball}.sha256`, `${digest}  ${asset}\n`);
console.log(`Packed ${tarball} (${statSync(tarball).size} bytes)\n${digest}`);
