import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmdirSync, rmSync, statSync, symlinkSync } from "node:fs";
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
assert.equal(plist(app, "CFBundleIdentifier"), "com.tronschell.emma");
run("codesign", ["--verify", "--deep", "--strict", app]);

const stage = mkdtempSync(path.join(tmpdir(), "emma-dmg-"));
try {
  run("ditto", [app, path.join(stage, "Emma.app")]);
  symlinkSync("/Applications", path.join(stage, "Applications"));
  run("hdiutil", ["create", "-volname", "Emma", "-srcfolder", stage, "-fs", "HFS+", "-format", "UDZO", "-quiet", dmg]);
} finally {
  rmSync(stage, { recursive: true, force: true });
}

const mount = mkdtempSync(path.join(tmpdir(), "emma-dmg-mount-"));
let attached = false;
try {
  run("hdiutil", ["attach", dmg, "-readonly", "-nobrowse", "-noautoopen", "-quiet", "-mountpoint", mount]);
  attached = true;
  const mounted = path.join(mount, "Emma.app");
  assert.deepEqual(readdirSync(mount).filter((name) => !name.startsWith(".")).sort(), ["Applications", "Emma.app"]);
  assert.ok(existsSync(mounted), "The disk image is missing Emma.app.");
  assert.equal(plist(mounted, "CFBundleShortVersionString"), version);
  assert.equal(plist(mounted, "CFBundleIdentifier"), "com.tronschell.emma");
  assert.equal(readlinkSync(path.join(mount, "Applications")), "/Applications");
  run("codesign", ["--verify", "--deep", "--strict", mounted]);
  for (const resource of ["emma-host", "emma-cli", "rg"]) assert.ok(existsSync(path.join(mounted, "Contents/Resources", resource)), `The disk image is missing ${resource}.`);
} finally {
  if (attached) assert.equal(spawnSync("hdiutil", ["detach", mount, "-quiet"], { stdio: "inherit" }).status, 0, `Could not detach ${mount}`);
  rmdirSync(mount);
}

console.log(`Verified Emma ${version}: ${dmg}`);
