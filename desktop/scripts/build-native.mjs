import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";

const desktop = path.resolve(import.meta.dirname, "..");
const run = (program, args) => execFileSync(program, args, { cwd: desktop, stdio: "inherit" });

function resourceCompiler() {
  if (spawnSync("rc.exe", ["/?"], { stdio: "ignore" }).error === undefined) return "rc.exe";
  const bin = path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Windows Kits", "10", "bin");
  const host = process.arch === "arm64" ? "arm64" : "x64";
  const versions = existsSync(bin) ? readdirSync(bin).filter((name) => name.startsWith("10.")).sort().reverse() : [];
  for (const version of [...versions, ""]) {
    const candidate = path.join(bin, version, host, "rc.exe");
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`No Windows SDK resource compiler for ${host}; install the Windows SDK or put rc.exe on PATH.`);
}

mkdirSync(path.join(desktop, "dist-native"), { recursive: true });

if (process.platform === "darwin") {
  run("clang", ["-O2", "-mmacosx-version-min=12.0", "-fobjc-arc", "-framework", "AppKit", "-framework", "ApplicationServices", "native/quick_ask.m", "-o", "dist-native/emma-option-tap"]);
  run(path.join(desktop, "dist-native/emma-option-tap"), ["--self-test"]);
  run("clang", ["-Wall", "-Wextra", "-Werror", "-O2", "-mmacosx-version-min=12.0", "-fobjc-arc", "-framework", "AppKit", "-framework", "ApplicationServices", "native/computer.m", "-o", "dist-native/emma-computer"]);
  run(path.join(desktop, "dist-native/emma-computer"), ["--self-test"]);
  run("clang", ["-O2", "-mmacosx-version-min=12.0", "-fobjc-arc", "-framework", "Foundation", "-framework", "Speech", "native/transcribe.m", "-o", "dist-native/emma-transcribe"]);
  run("clang", ["-O2", "-mmacosx-version-min=12.0", "native/pty.c", "-o", "dist-native/emma-pty"]);
  run(path.join(desktop, "dist-native/emma-pty"), ["--self-test"]);
} else if (process.platform === "win32") {
  const resource = "dist-native/emma-windows-helper.res";
  run(resourceCompiler(), ["/nologo", "/fo", resource, "native/windows-helper.rc"]);
  run("clang", ["-O2", "-Wall", "-Wextra", "-Werror", "-municode", "native/pty_win.c", resource, "-o", "dist-native/emma-pty.exe"]);
  run(path.join(desktop, "dist-native/emma-pty.exe"), ["--self-test"]);
  run("clang++", ["-O2", "-std=c++20", "-Wall", "-Wextra", "-Werror", "native/quick_ask_win.cpp", resource, "-luser32", "-o", "dist-native/emma-option-tap.exe"]);
  run(path.join(desktop, "dist-native/emma-option-tap.exe"), ["--self-test"]);
  run("clang++", ["-O2", "-std=c++20", "-Wall", "-Wextra", "-Werror", "-municode", "native/transcribe_win.cpp", resource, "-lsapi", "-lole32", "-o", "dist-native/emma-transcribe.exe"]);
  run(path.join(desktop, "dist-native/emma-transcribe.exe"), ["--self-test"]);
  const computer = path.join(desktop, "native/computer_win.cpp");
  if (!existsSync(computer)) throw new Error(`Missing Windows computer helper source: ${computer}`);
  run("clang++", ["-O2", "-std=c++20", "-Wall", "-Wextra", "-Werror", computer, resource, "-ladvapi32", "-lole32", "-loleaut32", "-luiautomationcore", "-luser32", "-municode", "-o", "dist-native/emma-computer.exe"]);
  run(path.join(desktop, "dist-native/emma-computer.exe"), ["--self-test"]);
}
