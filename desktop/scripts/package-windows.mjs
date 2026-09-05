import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, globSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { extractFile, listPackage } from "@electron/asar";
import { packager } from "@electron/packager";
import { createWindowsInstaller } from "electron-winstaller";
import { commandShimArguments, publishStagedBuild, squirrelStagingDirectory } from "./windows-command.mjs";

assert.equal(process.platform, "win32", "package:win requires Windows.");

const desktop = fileURLToPath(new URL("../", import.meta.url));
const root = fileURLToPath(new URL("../../", import.meta.url));
const out = path.resolve(process.argv[2] ?? path.join(desktop, "release"));
const staging = squirrelStagingDirectory();
const arch = process.arch;
assert.ok(["x64", "arm64"].includes(arch), "package:win supports x64 and arm64 Squirrel artifacts.");
const expectedMachine = arch === "x64" ? 0x8664 : 0xaa64;
const env = { ...process.env };
const run = (command, args, cwd = desktop) => {
  if (process.platform === "win32" && /\.cmd$/i.test(command)) {
    return execFileSync(process.env.ComSpec ?? "cmd.exe", commandShimArguments(command, args), { cwd, env, stdio: "inherit", windowsVerbatimArguments: true });
  }
  return execFileSync(command, args, { cwd, env, stdio: "inherit" });
};
const isPe = (bytes) => {
  if (bytes.length < 64 || bytes.readUInt16LE(0) !== 0x5a4d) return false;
  const offset = bytes.readUInt32LE(0x3c);
  return offset >= 64 && offset + 4 <= bytes.length && bytes.readUInt32LE(offset) === 0x00004550;
};
const peMachine = (bytes) => bytes.readUInt16LE(bytes.readUInt32LE(0x3c) + 4);
const verifyPeArchitecture = (file) => {
  const bytes = readFileSync(file);
  assert.ok(isPe(bytes), `Not a Windows PE file: ${file}`);
  assert.equal(peMachine(bytes), expectedMachine, `Wrong Windows architecture: ${file}`);
};
const filesUnder = (directory) => {
  const files = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) files.push(file);
    }
  };
  visit(directory);
  return files;
};
const verifyPeDirectory = (signTool, directory) => {
  let verified = 0;
  for (const file of filesUnder(directory)) if (isPe(readFileSync(file))) {
    run(signTool, ["verify", "/pa", "/all", file]);
    verified += 1;
  }
  assert.ok(verified > 0, `No executable PE files found under ${directory}`);
};
const zipEntries = (file) => {
  const archive = readFileSync(file);
  const eocd = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0 || eocd + 22 > archive.length) throw new Error(`Invalid nupkg: ${file}`);
  const count = archive.readUInt16LE(eocd + 10);
  const centralOffset = archive.readUInt32LE(eocd + 16);
  const entries = [];
  let offset = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== 0x02014b50) throw new Error(`Invalid nupkg central directory: ${file}`);
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const name = archive.toString("utf8", offset + 46, offset + 46 + nameLength).replaceAll("\\", "/");
    if (!name || name.startsWith("/") || name.split("/").includes("..")) throw new Error(`Invalid nupkg path: ${name}`);
    if (localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`Invalid nupkg entry: ${name}`);
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const end = start + compressedSize;
    if (end > archive.length) throw new Error(`Invalid nupkg entry: ${name}`);
    const compressed = archive.subarray(start, end);
    const data = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : (() => { throw new Error(`Unsupported nupkg compression for ${name}`); })();
    if (data.length !== uncompressedSize) throw new Error(`Invalid nupkg size for ${name}`);
    entries.push({ name, data });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
};
const verifyNupkg = (signTool, file) => {
  const extraction = mkdtempSync(path.join(tmpdir(), "emma-nupkg-"));
  try {
    let verified = 0;
    for (const entry of zipEntries(file)) {
      if (!isPe(entry.data)) continue;
      const target = path.join(extraction, ...entry.name.split("/"));
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, entry.data);
      run(signTool, ["verify", "/pa", "/all", target]);
      verified += 1;
    }
    assert.ok(verified > 0, `No executable PE files found in ${file}`);
  } finally {
    rmSync(extraction, { recursive: true, force: true });
  }
};
const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
assert.match(version, /^\d+\.\d+\.\d+$/, "The root package.json needs a stable X.Y.Z version.");

run("cargo", ["build", "--locked", "--release", "-p", "emma-host"], root);
run("zig", ["build", "-Doptimize=ReleaseSafe"], path.join(root, "harness"));
run("npm.cmd", ["run", "build:native"]);
run("npm.cmd", ["run", "vendor:ripgrep"]);
run("npm.cmd", ["run", "vendor:zvec-grep"]);
run("npm.cmd", ["run", "build"]);

const notices = path.join(staging, "notices");
mkdirSync(notices, { recursive: true });
for (const [source, name] of [
  ["LICENSE", "Emma-LICENSE.txt"],
  ["harness/LICENSE", "Harness-LICENSE.txt"],
  ["harness/THIRD_PARTY_NOTICES.md", "Harness-NOTICES.md"],
  ["harness/FORK.md", "Harness-FORK.md"],
  ["desktop/assets/DepartureMono-LICENSE.txt", "DepartureMono-LICENSE.txt"],
  ["desktop/assets/BRANDS-NOTICES.md", "BRANDS-NOTICES.md"],
  ["desktop/dist-renderer/.vite/license.md", "Renderer-LICENSES.md"],
]) cpSync(path.join(root, source), path.join(notices, name));
const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--locked", "--offline", "--format-version", "1"], { cwd: root, env, encoding: "utf8" }));
writeFileSync(path.join(notices, "Rust-LICENSES.txt"), metadata.packages.filter((pkg) => pkg.source).map((pkg) => {
  const cwd = path.dirname(pkg.manifest_path);
  const files = globSync(["LICENSE*", "COPYING*", "NOTICE*"], { cwd }).filter((name) => statSync(path.join(cwd, name)).isFile()).sort();
  assert.ok(files.length, `Missing license text for ${pkg.name}.`);
  return `${pkg.name} ${pkg.version}\n\n${files.map((name) => readFileSync(path.join(cwd, name), "utf8")).join("\n\n")}`;
}).join("\n\n"));
writeFileSync(path.join(notices, "Ripgrep-LICENSE.txt"), ["COPYING", "LICENSE-MIT", "UNLICENSE"].map((name) => readFileSync(path.join(desktop, "vendor", name), "utf8")).join("\n\n"));
const zvecModules = path.join(desktop, "vendor/zvec-grep/node_modules");
writeFileSync(path.join(notices, "Zvec-grep-LICENSES.txt"), globSync("**/{LICENSE,LICENCE,COPYING,NOTICE}*", { cwd: zvecModules }).filter((name) => statSync(path.join(zvecModules, name)).isFile()).sort().map((name) => `${name}\n\n${readFileSync(path.join(zvecModules, name), "utf8")}`).join("\n\n"));

const loadingGif = path.join(desktop, "assets/installer/emma-setup.gif");
assert.ok(existsSync(loadingGif), `Missing installer splash: ${loadingGif}`);

const nativeHelpers = ["emma-option-tap.exe", "emma-computer.exe", "emma-transcribe.exe", "emma-pty.exe"];
const required = [
  path.join(root, "target/release/emma-host.exe"),
  path.join(root, "harness/zig-out/bin/emma-cli.exe"),
  path.join(desktop, "vendor/rg.exe"),
  path.join(desktop, "vendor/zvec-grep"),
  ...nativeHelpers.map((name) => path.join(desktop, "dist-native", name)),
  path.join(desktop, "skills"),
  notices,
];
for (const resource of required) assert.ok(existsSync(resource), `Missing Windows resource: ${resource}`);

const ico = path.join(staging, "emma.ico");
cpSync(path.join(desktop, "assets/emma.ico"), ico);
const icon = readFileSync(ico);
assert.equal(icon.readUInt16LE(0), 0, "Invalid ICO reserved field.");
assert.equal(icon.readUInt16LE(2), 1, "Invalid ICO type.");
const iconSizes = [];
for (let entry = 0; entry < icon.readUInt16LE(4); entry += 1) {
  const at = 6 + 16 * entry;
  assert.equal(icon.readUInt16LE(at + 4), 1, "Invalid ICO color planes.");
  assert.equal(icon.readUInt16LE(at + 6), 32, "Invalid ICO bit depth.");
  assert.ok(icon.readUInt32LE(at + 12) + icon.readUInt32LE(at + 8) <= icon.length, "Invalid ICO image bounds.");
  iconSizes.push(icon[at] || 256);
}
for (const size of [16, 32, 48, 256]) assert.ok(iconSizes.includes(size), `The Windows icon is missing its ${size}px image.`);

const bundled = /^\/(?:package\.json$|dist-main(?:$|\/(?:main|shared)(?:\/|$))|dist-renderer(?:\/|$)|node_modules(?:$|\/ws(?:\/|$)))/;
await packager({
  dir: desktop,
  name: "Emma",
  icon: ico,
  platform: "win32",
  arch,
  out: staging,
  overwrite: true,
  asar: true,
  appVersion: version,
  buildVersion: version,
  win32metadata: { CompanyName: "Tronschell", ProductName: "Emma", FileDescription: "Emma" },
  extraResource: required,
  ignore: (file) => file !== "" && !bundled.test(file),
  afterCopy: [({ buildPath }) => {
    const file = path.join(buildPath, "package.json");
    const pkg = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, `${JSON.stringify({ ...pkg, productName: "Emma", version }, null, 2)}\n`);
  }],
});

const app = path.join(staging, `Emma-win32-${arch}`);
const executable = path.join(app, "Emma.exe");
assert.ok(existsSync(executable), `Missing packaged executable: ${executable}`);
verifyPeArchitecture(executable);
const archive = path.join(app, "resources", "app.asar");
assert.ok(existsSync(archive), `Missing packaged archive: ${archive}`);
assert.equal(JSON.parse(extractFile(archive, "package.json")).version, version);
const files = listPackage(archive).map((file) => file.replaceAll("\\", "/"));
for (const file of ["/dist-main/main/main.js", "/dist-main/main/preload.js", "/dist-renderer/index.html", "/dist-renderer/.vite/license.md", "/node_modules/ws/index.js"]) assert.ok(files.includes(file), `Missing packaged file: ${file}`);
assert.ok(files.every((file) => bundled.test(file)), "Source files must not ship in app.asar.");
for (const resource of required) {
  const file = path.join(app, "resources", path.basename(resource));
  assert.ok(existsSync(file), `Missing packaged resource: ${file}`);
  if (statSync(file).isFile()) verifyPeArchitecture(file);
}
const squirrel = path.join(staging, "squirrel");
mkdirSync(squirrel, { recursive: true });
const certificateFile = process.env.WINDOWS_CERT_PFX?.trim() ?? "";
const certificatePassword = process.env.WINDOWS_CERT_PASSWORD ?? "";
if (Boolean(certificateFile) !== Boolean(certificatePassword)) throw new Error("WINDOWS_CERT_PFX and WINDOWS_CERT_PASSWORD must be provided together.");
const windowsSign = certificateFile ? {
  certificateFile,
  certificatePassword,
  hashes: ["sha256"],
  timestampServer: process.env.WINDOWS_TIMESTAMP_SERVER?.trim() || "http://timestamp.digicert.com",
  description: "Emma",
  website: "https://github.com/tronschell/emma",
} : undefined;
await createWindowsInstaller({
  appDirectory: app,
  outputDirectory: squirrel,
  authors: "Tronschell",
  description: "A self-learning, self-building metaharness.",
  name: "Emma",
  exe: "Emma.exe",
  setupExe: `Emma-${version}-win32-${arch}-Setup.exe`,
  setupIcon: ico,
  loadingGif,
  iconUrl: "https://raw.githubusercontent.com/tronschell/emma/main/desktop/assets/emma.ico",
  noMsi: true,
  title: "Emma",
  version,
  ...(windowsSign ? { windowsSign } : {}),
});
const setup = path.join(squirrel, `Emma-${version}-win32-${arch}-Setup.exe`);
assert.ok(existsSync(setup), `Missing Windows installer: ${setup}`);
if (windowsSign) {
  const signTool = process.env.WINDOWS_SIGNTOOL_PATH?.trim() || "signtool.exe";
  run(signTool, ["verify", "/pa", "/all", setup]);
  verifyPeDirectory(signTool, app);
}
const nupkgs = globSync("*.nupkg", { cwd: squirrel });
assert.ok(nupkgs.length > 0, `Missing Squirrel package: ${squirrel}`);
if (windowsSign) {
  const signTool = process.env.WINDOWS_SIGNTOOL_PATH?.trim() || "signtool.exe";
  for (const nupkg of nupkgs) verifyNupkg(signTool, path.join(squirrel, nupkg));
}
const releases = path.join(squirrel, "RELEASES");
assert.ok(existsSync(releases), `Missing Squirrel release feed: ${releases}`);
const checksums = nupkgs.concat(path.basename(setup), "RELEASES").map((name) => {
  const file = path.join(squirrel, name);
  const digest = execFileSync("certutil", ["-hashfile", file, "SHA256"], { encoding: "utf8" }).split(/\r?\n/).map((line) => line.trim()).find((line) => /^[0-9a-f]{64}$/i.test(line));
  assert.ok(digest, `Missing checksum for ${file}`);
  return `${digest.toLowerCase()} *${name}`;
});
writeFileSync(path.join(squirrel, "SHA256SUMS"), `${checksums.join("\n")}\n`);
publishStagedBuild(staging, out, [`Emma-win32-${arch}`, "squirrel", "notices", "emma.ico"]);
console.log(`Verified Emma ${version}: ${path.join(out, "squirrel", path.basename(setup))}, ${nupkgs.length} Squirrel package(s), RELEASES`);
