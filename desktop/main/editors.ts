/* Which code editors this Mac has, and handing one of them a file. Detection is a
   bundle-exists check per known app, and the mark beside each is the app's own icon
   read out of that bundle — no second brand asset to ship, licence, and keep current. */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { app } from "electron";
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

let cached: Promise<EditorApp[]> | undefined;

/** Read once per launch: installing an editor mid-session is rarer than this re-rendering. */
export function installedEditors(): Promise<EditorApp[]> {
  cached ??= Promise.all(EDITORS.map(async ([id, label]) => {
    const at = bundle(id);
    if (!at) return undefined;
    const icon = await app.getFileIcon(at, { size: "normal" }).catch(() => null);
    return { id, label, icon: icon?.toDataURL() ?? "" };
  })).then((found) => found.filter((item): item is EditorApp => !!item));
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
