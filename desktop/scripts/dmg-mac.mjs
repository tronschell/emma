import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

assert.equal(process.platform, "darwin", "dmg:mac requires macOS.");

const desktop = fileURLToPath(new URL("../", import.meta.url));
const root = fileURLToPath(new URL("../../", import.meta.url));
const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
assert.match(version, /^\d+\.\d+\.\d+$/, "The root package.json needs a stable X.Y.Z version.");

const app = path.resolve(process.argv[2] ?? path.join(desktop, "release/Emma-darwin-arm64/Emma.app"));
const dmg = path.resolve(process.argv[3] ?? path.join(desktop, "release", `Emma-v${version}-darwin-arm64.dmg`));
assert.ok(existsSync(app) && statSync(app).isDirectory(), `Not a packaged app: ${app}`);

const run = (command, args) => execFileSync(command, args, { stdio: "inherit" });
const output = (command, args) => execFileSync(command, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
const plist = (bundle, key) => output("plutil", ["-extract", key, "raw", "-o", "-", path.join(bundle, "Contents/Info.plist")]).trim();
assert.equal(plist(app, "CFBundleShortVersionString"), version);

const stage = mkdtempSync(path.join(tmpdir(), "emma-dmg-"));
try {
  run("ditto", [app, path.join(stage, "Emma.app")]);
  symlinkSync("/Applications", path.join(stage, "Applications"));
  rmSync(dmg, { force: true });
  run("hdiutil", ["create", "-volname", "Emma", "-srcfolder", stage, "-fs", "HFS+", "-format", "UDZO", "-ov", "-quiet", dmg]);
} finally {
  rmSync(stage, { recursive: true, force: true });
}

const mount = mkdtempSync(path.join(tmpdir(), "emma-dmg-mount-"));
try {
  run("hdiutil", ["attach", dmg, "-readonly", "-nobrowse", "-noautoopen", "-quiet", "-mountpoint", mount]);
  const mounted = path.join(mount, "Emma.app");
  assert.ok(existsSync(mounted), "The disk image is missing Emma.app.");
  assert.equal(plist(mounted, "CFBundleShortVersionString"), version);
  assert.equal(plist(mounted, "CFBundleIdentifier"), "com.tronschell.emma");
  assert.equal(output("readlink", [path.join(mount, "Applications")]).trim(), "/Applications");
  for (const resource of ["emma-host", "emma-cli", "rg"]) assert.ok(existsSync(path.join(mounted, "Contents/Resources", resource)), `The disk image is missing ${resource}.`);
} finally {
  spawnSync("hdiutil", ["detach", mount, "-quiet"], { stdio: "inherit" });
  rmSync(mount, { recursive: true, force: true });
}

console.log(`Verified Emma ${version}: ${dmg}`);
