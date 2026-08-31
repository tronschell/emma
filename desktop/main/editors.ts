import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { app, nativeImage } from "electron";
import type { EditorApp } from "../shared/folders";
import { findExecutable, isWindows, spawnCommand, windowsSystemExecutable } from "./platform";

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

const WINDOWS_COMMANDS: Record<string, string[]> = {
  vscode: ["code.cmd", "code.exe"],
  "vscode-insiders": ["code-insiders.cmd", "code-insiders.exe"],
  cursor: ["cursor.exe"],
  windsurf: ["windsurf.exe"],
  zed: ["zed.exe"],
  antigravity: ["antigravity.exe"],
  trae: ["trae.exe"],
  kiro: ["kiro.exe"],
  void: ["void.exe"],
  positron: ["positron.exe"],
  sublime: ["subl.exe"],
  atom: ["atom.exe"],
  emacs: ["emacs.exe"],
  webstorm: ["webstorm64.exe", "webstorm.exe"],
  intellij: ["idea64.exe", "idea.exe"],
  "intellij-ce": ["idea64.exe", "idea.exe"],
  pycharm: ["pycharm64.exe", "pycharm.exe"],
  "pycharm-ce": ["pycharm64.exe", "pycharm.exe"],
  goland: ["goland64.exe", "goland.exe"],
  rustrover: ["rustrover64.exe", "rustrover.exe"],
  clion: ["clion64.exe", "clion.exe"],
  phpstorm: ["phpstorm64.exe", "phpstorm.exe"],
  rubymine: ["rubymine64.exe", "rubymine.exe"],
  rider: ["rider64.exe", "rider.exe"],
  datagrip: ["datagrip64.exe", "datagrip.exe"],
  fleet: ["fleet.exe"],
  eclipse: ["eclipse.exe"],
  "android-studio": ["studio64.exe", "studio.exe"],
};

const WINDOWS_INSTALLS: Record<string, string[]> = {
  vscode: ["Programs/Microsoft VS Code/Code.exe", "Microsoft VS Code/Code.exe"],
  "vscode-insiders": ["Programs/Microsoft VS Code Insiders/Code - Insiders.exe", "Microsoft VS Code Insiders/Code - Insiders.exe"],
  cursor: ["Programs/Cursor/Cursor.exe", "Cursor/Cursor.exe"],
  windsurf: ["Programs/Windsurf/Windsurf.exe", "Windsurf/Windsurf.exe"],
  zed: ["Programs/Zed/Zed.exe", "Zed/Zed.exe"],
  antigravity: ["Programs/Antigravity/Antigravity.exe", "Antigravity/Antigravity.exe"],
  trae: ["Programs/Trae/Trae.exe", "Trae/Trae.exe"],
  kiro: ["Programs/Kiro/Kiro.exe", "Kiro/Kiro.exe"],
  void: ["Programs/Void/Void.exe", "Void/Void.exe"],
  positron: ["Programs/Positron/Positron.exe", "Positron/Positron.exe"],
  sublime: ["Sublime Text/sublime_text.exe"],
  atom: ["Atom/atom.exe"],
  webstorm: ["JetBrains/WebStorm/bin/webstorm64.exe", "JetBrains/WebStorm/bin/webstorm.exe"],
  intellij: ["JetBrains/IntelliJ IDEA/bin/idea64.exe", "JetBrains/IntelliJ IDEA/bin/idea.exe"],
  "intellij-ce": ["JetBrains/IntelliJ IDEA Community Edition/bin/idea64.exe", "JetBrains/IntelliJ IDEA Community Edition/bin/idea.exe"],
  pycharm: ["JetBrains/PyCharm/bin/pycharm64.exe", "JetBrains/PyCharm/bin/pycharm.exe"],
  "pycharm-ce": ["JetBrains/PyCharm Community Edition/bin/pycharm64.exe", "JetBrains/PyCharm Community Edition/bin/pycharm.exe"],
  goland: ["JetBrains/GoLand/bin/goland64.exe", "JetBrains/GoLand/bin/goland.exe"],
  rustrover: ["JetBrains/RustRover/bin/rustrover64.exe", "JetBrains/RustRover/bin/rustrover.exe"],
  clion: ["JetBrains/CLion/bin/clion64.exe", "JetBrains/CLion/bin/clion.exe"],
  phpstorm: ["JetBrains/PhpStorm/bin/phpstorm64.exe", "JetBrains/PhpStorm/bin/phpstorm.exe"],
  rubymine: ["JetBrains/RubyMine/bin/rubymine64.exe", "JetBrains/RubyMine/bin/rubymine.exe"],
  rider: ["JetBrains/Rider/bin/rider64.exe", "JetBrains/Rider/bin/rider.exe"],
  datagrip: ["JetBrains/DataGrip/bin/datagrip64.exe", "JetBrains/DataGrip/bin/datagrip.exe"],
  fleet: ["JetBrains/Fleet/fleet.exe"],
  eclipse: ["Eclipse/eclipse.exe"],
  "android-studio": ["Android/Android Studio/bin/studio64.exe", "Android/Android Studio/bin/studio.exe"],
};

const WINDOWS_REGISTRY: Record<string, string[]> = Object.fromEntries(Object.entries(WINDOWS_COMMANDS).map(([id, names]) => [id, names.map((name) => name.replace(/\.cmd$/i, ""))]));

const DIRECTORIES = ["/Applications", path.join(homedir(), "Applications")];

function toolboxRoots(): string[] {
  const local = process.env.LOCALAPPDATA?.trim() || path.join(homedir(), "AppData", "Local");
  return [path.join(local, "JetBrains", "Toolbox", "apps"), path.join(local, "JetBrains", "Installations")];
}

function toolboxExecutable(id: string): string | undefined {
  const names = new Set((WINDOWS_COMMANDS[id] ?? []).map((name) => name.toLowerCase().replace(/\.cmd$/, "")));
  let visited = 0;
  for (const root of toolboxRoots()) {
    const pending: { directory: string; depth: number }[] = [{ directory: root, depth: 0 }];
    while (pending.length && visited < 4096) {
      const current = pending.shift()!;
      let entries: import("node:fs").Dirent[];
      try { entries = readdirSync(current.directory, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        visited += 1;
        const candidate = path.join(current.directory, entry.name);
        if (entry.isFile() && names.has(entry.name.toLowerCase())) return candidate;
        if (entry.isDirectory() && current.depth < 7) pending.push({ directory: candidate, depth: current.depth + 1 });
        if (visited >= 4096) break;
      }
    }
  }
  return undefined;
}

async function windowsCommand(id: string): Promise<string | undefined> {
  const commands = WINDOWS_COMMANDS[id] ?? [];
  const fromPath = await Promise.all(commands.map((command) => findExecutable(command))).then((found) => found.find((value): value is string => Boolean(value)));
  if (fromPath) return fromPath;
  const roots = [...new Set([process.env.LOCALAPPDATA, process.env.ProgramFiles, process.env.ProgramW6432, process.env["ProgramFiles(x86)"]].filter((value): value is string => Boolean(value?.trim())))];
  for (const root of roots) for (const relative of WINDOWS_INSTALLS[id] ?? []) {
    const found = await findExecutable(relative, root);
    if (found) return found;
  }
  const toolbox = toolboxExecutable(id);
  if (toolbox) {
    const found = await findExecutable(toolbox);
    if (found) return found;
  }
  for (const name of WINDOWS_REGISTRY[id] ?? []) {
    for (const base of [
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths",
      "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths",
      "HKLM\\Software\\Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths",
    ]) {
      const key = `${base}\\${name}`;
      const value = await new Promise<string | undefined>((resolve) => {
        const child = spawnCommand(windowsSystemExecutable("reg.exe"), ["query", key, "/ve"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
        let output = "";
        child.stdout?.on("data", (chunk: Buffer) => { output = `${output}${chunk}`.slice(0, 4096); });
        child.once("error", () => resolve(undefined));
        child.once("close", (code) => {
          if (code !== 0) return resolve(undefined);
          const raw = /REG_SZ\s+(.+?)(?:\r?\n|$)/i.exec(output)?.[1]?.trim();
          if (!raw) return resolve(undefined);
          resolve(/^"([^"]+)"/.exec(raw)?.[1] ?? raw.split(/\s+/)[0]);
        });
      });
      if (value) {
        const found = await findExecutable(value);
        if (found) return found;
      }
    }
  }
  return undefined;
}

function macBundle(id: string): string | undefined {
  const name = EDITORS.find(([key]) => key === id)?.[1];
  return name ? DIRECTORIES.map((directory) => path.join(directory, `${name}.app`)).find(existsSync) : undefined;
}

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

const MARK = 40;

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
  return (best ?? biggest)?.body;
}

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

export function installedEditors(): Promise<EditorApp[]> {
  cached ??= Promise.all(EDITORS.map(async ([id, label]) => {
    const at = isWindows ? await windowsCommand(id) : macBundle(id);
    if (!at) return undefined;
    let icon = "";
    try {
      let source: Electron.NativeImage;
      if (isWindows) source = await app.getFileIcon(at, { size: "normal" });
      else {
        const file = iconFile(at);
        const png = file ? embeddedPng(file) : undefined;
        source = nativeImage.createFromBuffer(png ?? Buffer.alloc(0));
      }
      if (!source.isEmpty()) icon = trimmed(source).resize({ width: MARK, height: MARK, quality: "best" }).toDataURL();
    } catch {
      icon = "";
    }
    return { id, label, icon };
  })).then((items) => items.filter((item): item is EditorApp => !!item));
  return cached;
}

export async function openInEditor(id: string, file: string): Promise<void> {
  const at = isWindows ? await windowsCommand(id) : macBundle(id);
  if (!at) throw new Error("That editor is not installed.");
  await new Promise<void>((resolve, reject) => {
    const child = spawnCommand(isWindows ? at : "open", isWindows ? [file] : ["-a", at, file], { windowsHide: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`The editor exited with code ${code ?? "?"}.`)));
  });
}
