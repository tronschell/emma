import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";

const app = path.resolve(process.argv[2] ?? "");
assert.equal(path.basename(app), "Emma.app");
assert.equal(path.basename(path.dirname(app)), "Emma-darwin-arm64");
assert.equal(execFileSync("plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", path.join(app, "Contents/Info.plist")], { encoding: "utf8" }).trim(), "com.tronschell.emma");

const roots = [
  path.join(app, "Contents/Frameworks/Electron Framework.framework/Versions/A/Resources"),
  path.join(app, "Contents/Resources"),
];

for (const root of roots) {
  const locales = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".lproj") && entry.name !== "en.lproj");
  await Promise.all(locales.map((entry) => rm(path.join(root, entry.name), { recursive: true })));
}
