import path from "node:path";

const windowsMeta = /([()\][%!^"`<>&|;, *?])/g;

function assertWindowsValue(value) {
  if (value.includes("\0") || value.includes("\r") || value.includes("\n")) throw new TypeError("Windows process arguments cannot contain NUL or line breaks");
}

function escapeWindowsCommand(value) {
  assertWindowsValue(value);
  return value.replace(windowsMeta, "^$1");
}

function escapeWindowsArgument(value) {
  assertWindowsValue(value);
  const escaped = value.replace(/(?=(\\+?)?)\1"/g, "$1$1\\\"").replace(/(?=(\\+?)?)\1$/g, "$1$1");
  return `"${escaped}"`.replace(windowsMeta, "^$1").replace(windowsMeta, "^$1");
}

export function commandShimArguments(command, args) {
  return ["/d", "/s", "/c", `"${[escapeWindowsCommand(command), ...args.map(escapeWindowsArgument)].join(" ")}"`];
}

export function windowsSystemExecutable(name, environment = process.env) {
  const root = [environment.SystemRoot, environment.WINDIR].find((value) => value && path.win32.isAbsolute(value)) || "C:\\Windows";
  return path.win32.join(root, "System32", name);
}
