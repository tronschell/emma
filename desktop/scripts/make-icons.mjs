/* The app icon, drawn from the same pixel bow the UI wears (`Mark` in src/icons.tsx),
   as an Icon Composer document: macOS 26 lights, masks and tints it itself, and older
   systems get the flattened .icns actool falls back to. Run by hand after touching the
   grid: `node scripts/make-icons.mjs`. */
import { execFileSync } from "node:child_process";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const BOW = [
  ".####......####.",
  ".######..######.",
  ".##..##oo##..##.",
  ".##..##oo##..##.",
  ".##..##oo##..##.",
  ".######oo######.",
  ".####..oo..####.",
  "......####......",
  ".....##..##.....",
  "....###..###....",
  "....##....##....",
];
const INK = "#f4156b";
const SIZE = 1024;
const CELL = 40;             // one bow pixel

const ink = [];
BOW.forEach((row, y) => [...row].forEach((cell, x) => { if (cell !== ".") ink.push({ x, y, half: cell === "o" }); }));
const origin = (key) => SIZE / 2 - (Math.min(...ink.map((p) => p[key])) + Math.max(...ink.map((p) => p[key])) + 1) * CELL / 2;
const [originX, originY] = [origin("x"), origin("y")];
const rects = ink.map(({ x, y, half }) => `<rect x="${originX + x * CELL}" y="${originY + y * CELL}" width="${CELL}" height="${CELL}"${half ? ` opacity=".5"` : ""}/>`);

const assets = path.join(import.meta.dirname, "..", "assets");
const doc = path.join(assets, "emma.icon");
execFileSync("mkdir", ["-p", path.join(doc, "Assets")]);
writeFileSync(path.join(doc, "Assets", "bow.svg"), `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}" fill="${INK}">${rects.join("")}</svg>\n`);
writeFileSync(path.join(doc, "icon.json"), `${JSON.stringify({
  fill: { "automatic-gradient": "extended-srgb:0.07059,0.07059,0.07059,1.00000" },
  groups: [{ layers: [{ "image-name": "bow.svg", name: "Bow" }], shadow: { kind: "neutral", opacity: 0.5 }, translucency: { enabled: true, value: 0.5 } }],
  "supported-platforms": { circles: ["watchOS"], squares: "shared" },
}, null, 2)}\n`);

/* electron-packager compiles the document into the Assets.car macOS 26 reads, at
   package time — all we want from actool here is the .icns older systems fall back
   to. Icon Composer only ships inside Xcode, so reach past the command line tools. */
execFileSync("/Applications/Xcode.app/Contents/Developer/usr/bin/actool", [doc, "--compile", assets, "--app-icon", "Emma", "--include-all-app-icons", "--output-partial-info-plist", path.join(assets, "icon.plist"), "--platform", "macosx", "--minimum-deployment-target", "12.0"], { stdio: "ignore" });
renameSync(path.join(assets, "Emma.icns"), path.join(assets, "emma.icns"));
rmSync(path.join(assets, "icon.plist"));
rmSync(path.join(assets, "Assets.car"));

/* Electron's nativeImage cannot read .icns, and an unpackaged run has no bundle icon
   to inherit — so leave the largest slice actool drew behind for the dev Dock, which
   is a 128pt tile anyway. */
const iconset = path.join(assets, "emma.iconset");
execFileSync("iconutil", ["-c", "iconset", path.join(assets, "emma.icns"), "-o", iconset]);
renameSync(path.join(iconset, "icon_128x128@2x.png"), path.join(assets, "emma-dock.png"));
rmSync(iconset, { recursive: true });
