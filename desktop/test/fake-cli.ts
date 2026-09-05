import { writeFile } from "node:fs/promises";
import path from "node:path";
import { isWindows } from "../main/platform";

export const NO_MULTILINE_PROMPT = isWindows && "cmd.exe cannot carry a multi-line prompt into a .cmd-shimmed harness";

export async function writeFakeCli(directory: string, body: string): Promise<string> {
  if (!isWindows) {
    const binary = path.join(directory, "agent");
    await writeFile(binary, `#!${process.execPath}\n${body}`, { mode: 0o700 });
    return binary;
  }
  const script = path.join(directory, "agent.js");
  await writeFile(script, body);
  const shim = path.join(directory, "agent.cmd");
  await writeFile(shim, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  return shim;
}
