import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { cpSync, globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packager } from "@electron/packager";
import { extractFile, listPackage } from "@electron/asar";
import { stableVersion } from "./release.mjs";

assert.equal(process.platform, "darwin", "package:mac requires macOS.");
assert.equal(process.arch, "arm64", "package:mac currently supports Apple silicon only.");

const developer = process.env.DEVELOPER_DIR ?? execFileSync("xcode-select", ["--print-path"], { encoding: "utf8" }).trim();
process.env.DEVELOPER_DIR = developer.endsWith("/CommandLineTools") ? "/Applications/Xcode.app/Contents/Developer" : developer;
execFileSync("xcrun", ["--find", "actool"], { stdio: "ignore" });

const desktop = fileURLToPath(new URL("../", import.meta.url));
const root = fileURLToPath(new URL("../../", import.meta.url));
const out = path.resolve(process.argv[2] ?? path.join(desktop, "release"));
const env = { ...process.env, MACOSX_DEPLOYMENT_TARGET: "12.0" };
const run = (command, args, cwd = desktop) => execFileSync(command, args, { cwd, env, stdio: "inherit" });
const runAsync = (command, args, cwd = desktop) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd, env, stdio: "inherit" });
  child.once("error", reject);
  child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code ?? signal}`)));
});
const output = (command, args, cwd = desktop) => execFileSync(command, args, { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const version = stableVersion(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version);
const electronChecksums = JSON.parse(readFileSync(path.join(desktop, "node_modules/electron/checksums.json"), "utf8"));
const zigOptimize = process.env.EMMA_FAST_BUILD === "1" ? "Debug" : "ReleaseSafe";

await Promise.all([
  runAsync("cargo", ["build", "--locked", "--release", "-p", "emma-host"], root),
  runAsync("zig", ["build", `-Doptimize=${zigOptimize}`, "-Dtarget=aarch64-macos.12.0"], path.join(root, "harness")),
  ...["build:native", "vendor:ripgrep", "build:main", "build:renderer"].map((script) => runAsync("npm", ["run", script])),
]);

const notices = path.join(out, "notices");
mkdirSync(notices, { recursive: true });
for (const [source, name] of [
  ["LICENSE", "Emma-LICENSE.txt"],
  ["harness/LICENSE", "Harness-LICENSE.txt"],
  ["harness/THIRD_PARTY_NOTICES.md", "Harness-NOTICES.md"],
  ["harness/FORK.md", "Harness-FORK.md"],
  ["desktop/assets/DepartureMono-LICENSE.txt", "DepartureMono-LICENSE.txt"],
  ["desktop/assets/BRANDS-NOTICES.md", "BRANDS-NOTICES.md"],
  ["desktop/dist-renderer/.vite/license.md", "Renderer-LICENSES.md"],
]) cpSync(path.join(root, source), path.join(notices, name));
writeFileSync(path.join(notices, "Ripgrep-LICENSE.txt"), ["COPYING", "LICENSE-MIT", "UNLICENSE"].map((name) => readFileSync(path.join(desktop, "vendor", name), "utf8")).join("\n\n"));
const metadata = JSON.parse(output("cargo", ["metadata", "--locked", "--offline", "--filter-platform", "aarch64-apple-darwin", "--format-version", "1"], root));
writeFileSync(path.join(notices, "Rust-LICENSES.txt"), metadata.packages.filter((pkg) => pkg.source).map((pkg) => {
  const cwd = path.dirname(pkg.manifest_path);
  const files = globSync(["LICENSE*", "COPYING*", "NOTICE*"], { cwd }).filter((name) => statSync(path.join(cwd, name)).isFile()).sort();
  // Crates that ship no license text (most of the objc2 family) still declare an SPDX expression.
  assert.ok(files.length || pkg.license, `Missing license for ${pkg.name}.`);
  const text = files.length ? files.map((name) => readFileSync(path.join(cwd, name), "utf8")).join("\n\n") : pkg.license;
  return `${pkg.name} ${pkg.version}\n\n${text}`;
}).join("\n\n"));

const resources = [
  path.join(root, "target/release/emma-host"),
  path.join(root, "harness/zig-out/bin/emma-cli"),
  path.join(desktop, "vendor/rg"),
  ...["emma-option-tap", "emma-computer", "emma-transcribe", "emma-pty"].map((name) => path.join(desktop, "dist-native", name)),
  path.join(desktop, "skills"),
  notices,
];
const bundled = /^\/(?:package\.json$|dist-main(?:$|\/(?:main|shared)(?:\/|$))|dist-renderer(?:\/|$)|node_modules(?:$|\/ws(?:\/|$)))/;
const iconDirectory = mkdtempSync(path.join(tmpdir(), "emma-package-icon-"));
const icon = path.join(iconDirectory, "emma.icns");
cpSync(path.join(desktop, "assets/emma.icns"), icon);
try {
  await packager({
    dir: desktop,
    name: "Emma",
    icon,
    platform: "darwin",
    arch: "arm64",
    out,
    overwrite: true,
    asar: true,
    prune: false,
    download: { checksums: electronChecksums },
    appBundleId: "com.tronschell.emma",
    appVersion: version,
    buildVersion: version,
    extendInfo: path.join(desktop, "native/Info.extra.plist"),
    extraResource: resources,
    ignore: (file) => file !== "" && !bundled.test(file),
    afterCopy: [({ buildPath }) => {
      const file = path.join(buildPath, "package.json");
      const pkg = JSON.parse(readFileSync(file, "utf8"));
      writeFileSync(file, `${JSON.stringify({ ...pkg, version }, null, 2)}\n`);
    }],
  });
} finally {
  rmSync(iconDirectory, { recursive: true, force: true });
}
const app = path.join(out, "Emma-darwin-arm64/Emma.app");
run(process.execPath, ["scripts/trim-packaged-locales.mjs", app]);
const archive = path.join(app, "Contents/Resources/app.asar");
const plist = (key) => output("plutil", ["-extract", key, "raw", "-o", "-", path.join(app, "Contents/Info.plist")]).trim();
assert.equal(plist("CFBundleShortVersionString"), version);
assert.equal(plist("CFBundleVersion"), version);
assert.equal(plist("CFBundleIdentifier"), "com.tronschell.emma");
assert.equal(plist("LSMinimumSystemVersion"), "12.0");
assert.equal(JSON.parse(extractFile(archive, "package.json")).version, version);
const files = listPackage(archive);
for (const file of ["/dist-main/main/main.js", "/dist-main/main/preload.js", "/dist-renderer/index.html", "/dist-renderer/.vite/license.md"]) assert.ok(files.includes(file), `Missing packaged file: ${file}`);
assert.ok(files.every((file) => bundled.test(file)), "Source files must not ship in app.asar.");
for (const resource of resources) {
  const file = path.join(app, "Contents/Resources", path.basename(resource));
  const stat = statSync(file);
  if (!stat.isFile()) continue;
  assert.ok(stat.mode & 0o111, `Not executable: ${file}`);
  assert.match(output("file", ["-b", file]), /Mach-O.*arm64/, `Wrong binary architecture: ${file}`);
  const minimum = output("otool", ["-l", file]).match(/\bminos (\d+(?:\.\d+)*)/);
  assert.ok(minimum, `Missing macOS deployment target: ${file}`);
  const [major, minor = 0, patch = 0] = minimum[1].split(".").map(Number);
  assert.ok(major < 12 || (major === 12 && minor === 0 && patch === 0), `Binary requires a newer macOS: ${file}`);
  const libraries = output("otool", ["-L", file]).trim().split("\n").slice(1);
  assert.ok(libraries.every((line) => /^\s*\/(?:usr\/lib\/|System\/Library\/)/.test(line)), `Unbundled native dependency: ${file}`);
}
for (const name of ["emma-option-tap", "emma-computer", "emma-pty"]) run(path.join(app, "Contents/Resources", name), ["--self-test"]);
assert.equal(execFileSync(path.join(app, "Contents/Resources/rg"), ["--pcre2", "--only-matching", "(?<=release-)ready"], { input: "release-ready\n", encoding: "utf8" }).trim(), "ready");
console.log(`Verified Emma ${version}: ${app}`);
