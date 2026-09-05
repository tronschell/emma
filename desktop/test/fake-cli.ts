import { writeFile } from "node:fs/promises";
import path from "node:path";
import { isWindows } from "../main/platform";

export async function writeFakeCli(directory: string, body: string): Promise<string> {
  if (!isWindows) {
    const binary = path.join(directory, "agent");
    await writeFile(binary, `#!${process.execPath}\n${body}`, { mode: 0o700 });
    return binary;
  }
  const script = path.join(directory, "agent.js");
  await writeFile(script, body);
  const shim = path.join(directory, "agent.cmd");
  await writeFile(shim, [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    "",
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ") ELSE (",
    '  SET "_prog=node"',
    "  SET PATHEXT=%PATHEXT:;.JS;=;%",
    ")",
    "",
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\agent.js" %*',
    "",
  ].join("\r\n"));
  return shim;
}
