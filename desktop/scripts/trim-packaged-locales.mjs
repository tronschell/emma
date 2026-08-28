import { readdir, rm } from "node:fs/promises";
import path from "node:path";

const expectedApp = path.resolve("release/Emma-darwin-arm64/Emma.app");
const app = path.resolve(process.argv[2] ?? "");
if (app !== expectedApp) throw new Error(`Expected ${expectedApp}`);

const roots = [
  path.join(app, "Contents/Frameworks/Electron Framework.framework/Versions/A/Resources"),
  path.join(app, "Contents/Resources"),
];

for (const root of roots) {
  const locales = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".lproj") && entry.name !== "en.lproj");
  await Promise.all(locales.map((entry) => rm(path.join(root, entry.name), { recursive: true })));
}
