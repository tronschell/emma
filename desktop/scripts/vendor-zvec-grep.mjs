import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const VERSION = "0.2.1";
const vendor = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "vendor", "zvec-grep");
const stamp = path.join(vendor, "zvec-grep.version");
const want = `@zvec/zvec-grep ${VERSION} ${process.platform} ${process.arch}\n`;
const entry = path.join(vendor, "node_modules/@zvec/zvec-grep/dist/cli/index.js");

if (existsSync(entry) && existsSync(stamp) && readFileSync(stamp, "utf8") === want) {
  console.log(`zvec-grep ${VERSION} already vendored.`);
  process.exit(0);
}

rmSync(vendor, { recursive: true, force: true });
mkdirSync(vendor, { recursive: true });
writeFileSync(path.join(vendor, "package.json"), `${JSON.stringify({ name: "emma-zvec-grep", private: true, dependencies: { "@zvec/zvec-grep": VERSION } }, null, 2)}\n`);
execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock"], { cwd: vendor, stdio: "inherit", shell: process.platform === "win32" });

const onnx = path.join(vendor, "node_modules/onnxruntime-node/bin/napi-v3");
for (const platform of readdirSync(onnx)) {
  if (platform !== process.platform) { rmSync(path.join(onnx, platform), { recursive: true, force: true }); continue; }
  for (const arch of readdirSync(path.join(onnx, platform))) if (arch !== process.arch) rmSync(path.join(onnx, platform, arch), { recursive: true, force: true });
}
// node-llama-cpp ships an xpack cmake toolchain only needed to build llama.cpp from source, and it
// contains an absolute symlink. codesign rejects any absolute symlink inside a bundle, so packaging
// a copy of this tree fails signing. The prebuilt binaries it loads at runtime live elsewhere.
rmSync(path.join(vendor, "node_modules/node-llama-cpp/llama/xpack"), { recursive: true, force: true });
if (!existsSync(entry)) throw new Error(`zvec-grep did not install: ${entry} is missing.`);
writeFileSync(stamp, want);
console.log(`Vendored zvec-grep ${VERSION} to ${vendor}`);
