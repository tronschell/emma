import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readlinkSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const desktop = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = /ZVEC_GREP_VERSION = "([^"]+)"/.exec(readFileSync(path.join(desktop, "shared", "zvec-grep.ts"), "utf8"))?.[1];
if (!VERSION) throw new Error("shared/zvec-grep.ts does not name a version.");
const vendor = path.join(desktop, "vendor", "zvec-grep");
const stamp = path.join(vendor, "zvec-grep.version");
const want = `@zvec/zvec-grep ${VERSION} ${process.platform} ${process.arch}\n`;
const entry = path.join(vendor, "node_modules/@zvec/zvec-grep/dist/cli/index.js");
const cmake = path.join(vendor, "node_modules/node-llama-cpp/llama/xpack/xpacks/@xpack-dev-tools/cmake");

function makeCmakeLinkRelative() {
  if (!existsSync(cmake)) return;
  const target = readlinkSync(cmake);
  if (!path.isAbsolute(target)) return;
  rmSync(cmake);
  symlinkSync(path.relative(path.dirname(cmake), target), cmake);
}

if (existsSync(entry) && existsSync(stamp) && readFileSync(stamp, "utf8") === want) {
  makeCmakeLinkRelative();
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
makeCmakeLinkRelative();
if (!existsSync(entry)) throw new Error(`zvec-grep did not install: ${entry} is missing.`);
writeFileSync(stamp, want);
console.log(`Vendored zvec-grep ${VERSION} to ${vendor}`);
