/* Which code editors this Mac has, and handing one of them a file. Detection is a
   bundle-exists check per known app, and the mark beside each is the app's own icon
   read out of that bundle — no second brand asset to ship, licence, and keep current. */

import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { nativeImage } from "electron";
import type { EditorApp } from "../shared/folders";

/** Bundle names, in the order the row draws them. */
const EDITORS: readonly (readonly [string, string])[] = [
  ["vscode", "Visual Studio Code"],
  ["vscode-insiders", "Visual Studio Code - Insiders"],
  ["cursor", "Cursor"],
  ["windsurf", "Windsurf"],
  ["zed", "Zed"],
  ["antigravity", "Antigravity"],
  ["trae", "Trae"],
  ["kiro", "Kiro"],
  ["void", "Void"],
  ["positron", "Positron"],
  ["sublime", "Sublime Text"],
  ["atom", "Atom"],
  ["nova", "Nova"],
  ["bbedit", "BBEdit"],
  ["textmate", "TextMate"],
  ["emacs", "Emacs"],
  ["webstorm", "WebStorm"],
  ["intellij", "IntelliJ IDEA"],
  ["intellij-ce", "IntelliJ IDEA CE"],
  ["pycharm", "PyCharm"],
  ["pycharm-ce", "PyCharm CE"],
  ["goland", "GoLand"],
  ["rustrover", "RustRover"],
  ["clion", "CLion"],
  ["phpstorm", "PhpStorm"],
  ["rubymine", "RubyMine"],
  ["rider", "Rider"],
  ["datagrip", "DataGrip"],
  ["fleet", "Fleet"],
  ["eclipse", "Eclipse"],
  ["android-studio", "Android Studio"],
  ["xcode", "Xcode"],
];

const DIRECTORIES = ["/Applications", path.join(homedir(), "Applications")];

function bundle(id: string): string | undefined {
  const name = EDITORS.find(([key]) => key === id)?.[1];
  return name ? DIRECTORIES.map((directory) => path.join(directory, `${name}.app`)).find(existsSync) : undefined;
}

/** The `.icns` a bundle names, or the only one it ships. `app.getFileIcon` is the
    obvious API for this and it is the reason every mark used to be the same blank
    square: on macOS it answers with the generic bundle placeholder for third-party
    apps, so Zed, Cursor and Ghostty all came back byte-identical. */
export function iconFile(at: string): string | undefined {
  const resources = path.join(at, "Contents/Resources");
  if (!existsSync(resources)) return undefined;
  const plist = path.join(at, "Contents/Info.plist");
  const named = existsSync(plist)
    ? /<key>CFBundleIconFile<\/key>\s*<string>([^<]+)<\/string>/.exec(readFileSync(plist, "utf8"))?.[1]
    : undefined;
  const wanted = named && (named.endsWith(".icns") ? named : `${named}.icns`);
  if (wanted && existsSync(path.join(resources, wanted))) return path.join(resources, wanted);
  const any = readdirSync(resources).find((file) => file.toLowerCase().endsWith(".icns"));
  return any && path.join(resources, any);
}

/** Source pixels per mark: clear of 2x the 18px `.open-in img` with room for it to grow,
    and the threshold the icns chunk is picked against. */
const MARK = 40;

/** An `.icns` is a flat run of typed chunks and the modern ones hold a PNG outright,
    so the smallest chunk at or above the mark's own pixel size is the whole decode —
    no encoder, no subprocess, and nothing read from the 1024px chunk some apps lead with. */
export function embeddedPng(file: string): Buffer | undefined {
  const raw = readFileSync(file);
  let at = 8;
  let best: { side: number; body: Buffer } | undefined;
  let biggest: { side: number; body: Buffer } | undefined;
  while (at + 8 <= raw.length) {
    const size = raw.readUInt32BE(at + 4);
    if (size < 8) break;
    const body = raw.subarray(at + 8, at + size);
    at += size;
    if (body.subarray(1, 4).toString("ascii") !== "PNG" || body.length < 24) continue;
    const side = body.readUInt32BE(16);
    if (side >= MARK && (!best || side < best.side)) best = { side, body };
    if (!biggest || side > biggest.side) biggest = { side, body };
  }
  // An app that ships nothing above 40px gets its largest chunk scaled up: soft beats
  // falling through to the letter initial.
  return (best ?? biggest)?.body;
}

/** macOS bakes a transparent margin into every app tile so the squircle can breathe on
    a desktop. At 20px that margin is a third of the area, and the row is not a desktop —
    cropping to the opaque bounds is ~1.23x more mark in the same box. */
function trimmed(image: Electron.NativeImage): Electron.NativeImage {
  const { width, height } = image.getSize();
  const pixels = image.toBitmap();
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (pixels[(y * width + x) * 4 + 3] < 16) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return maxX < 0 ? image : image.crop({ x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 });
}

let cached: Promise<EditorApp[]> | undefined;

/** Read once per launch: installing an editor mid-session is rarer than this re-rendering. */
export function installedEditors(): Promise<EditorApp[]> {
  cached ??= Promise.resolve(EDITORS.map(([id, label]) => {
    const at = bundle(id);
    if (!at) return undefined;
    let icon = "";
    try {
      const file = iconFile(at);
      const png = file && embeddedPng(file);
      if (png) icon = trimmed(nativeImage.createFromBuffer(png))
        .resize({ width: MARK, height: MARK, quality: "best" }).toDataURL();
    } catch { /* an unreadable bundle falls back to the initial, same as one with no icns */ }
    return { id, label, icon };
  }).filter((item): item is EditorApp => !!item));
  return cached;
}

/** `open -a` on the bundle that was detected, so no editor's command-line shim has to
    be installed for its app to take the file. The path is already contained by the grant. */
export function openInEditor(id: string, file: string): Promise<void> {
  const at = bundle(id);
  if (!at) throw new Error("That editor is not installed.");
  return new Promise((resolve, reject) => {
    execFile("open", ["-a", at, file], (error) => error ? reject(error) : resolve());
  });
}
