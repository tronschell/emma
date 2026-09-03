import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { hookRuns, matchesPluginQuery, parseHooksFile, parseHostedApps, parseMarketplace, parseMarketplaceSource, parsePluginInterface, parsePluginManifest, pluginCategories, type HookEvent } from "../shared/plugins";
import { addMarketplace, ensureDefaultMarketplace, imageType, installedCapabilitySources, installPlugin, pluginDetail, readCatalog, removeMarketplace, runPluginHooks, setHookTrust, trustPluginHooks, uninstallPlugin, unpack, writePlugin } from "../main/marketplace";
import { loadImportedSkill, mirrorSkillsToHarness, parseMcpConfig, searchImportedSkills } from "../main/capabilities";

test("the plugins route stays lazy without making activity eager", () => {
  const app = readFileSync(path.join(__dirname, "../../src/App.tsx"), "utf8");
  const activity = readFileSync(path.join(__dirname, "../../src/ActivityView.tsx"), "utf8");
  assert.doesNotMatch(app, /import\s+\{\s*PluginsView\s*\}\s+from\s+["']\.\/plugins["']/);
  assert.match(app, /const PluginsView = lazy\(\(\) => import\(["']\.\/plugins["']\)/);
  assert.match(app, /view === "plugins" \? <Suspense[\s\S]*?<PluginsView\b/);
  assert.doesNotMatch(activity, /from\s+["']\.\/plugins["']/);
});

test("a marketplace source is a GitHub repo, a Git URL, or a folder — and nothing else", () => {
  assert.deepEqual(parseMarketplaceSource("openai/plugins"), { kind: "git", url: "https://github.com/openai/plugins.git", ref: "", sparse: [] });
  assert.deepEqual(parseMarketplaceSource("openai/plugins@next"), { kind: "git", url: "https://github.com/openai/plugins.git", ref: "next", sparse: [] });
  assert.deepEqual(parseMarketplaceSource("openai/plugins@next", "pinned"), { kind: "git", url: "https://github.com/openai/plugins.git", ref: "pinned", sparse: [] });
  assert.deepEqual(parseMarketplaceSource("git@github.com:org/repo.git", "main", "plugins/codex\nplugins/shared"), {
    kind: "git", url: "git@github.com:org/repo.git", ref: "main", sparse: ["plugins/codex", "plugins/shared"],
  });
  assert.deepEqual(parseMarketplaceSource("~/Documents/plugins"), { kind: "local", path: "~/Documents/plugins" });

  assert.throws(() => parseMarketplaceSource(""), /GitHub repo/);
  assert.throws(() => parseMarketplaceSource("./plugins"), /full path/);
  assert.throws(() => parseMarketplaceSource("not a repo"), /cannot read/);
  assert.throws(() => parseMarketplaceSource("openai/plugins", "--upload-pack=touch /tmp/pwned"), /not a Git ref/);
  assert.throws(() => parseMarketplaceSource("openai/plugins", "main~1"), /not a Git ref/);
  assert.throws(() => parseMarketplaceSource("/tmp/plugins", "", "plugins/codex"), /only apply to Git/);
  assert.throws(() => parseMarketplaceSource("openai/plugins", "", "../../etc"), /not a path inside the plugin/);
});

test("a marketplace listing keeps what Emma can install and says why it skipped the rest", () => {
  const listing = parseMarketplace({
    name: "Acme Plugins",
    interface: { displayName: "Acme" },
    plugins: [
      { name: "Ship It", description: "Ships things.", category: "developer_tools", keywords: ["deploy", "ci"], source: "./plugins/ship-it" },
      { name: "Charts", source: { source: "npm", package: "@acme/charts" }, category: "Data and analytics" },
      { name: "Signin", source: { source: "git-subdir", url: "https://example.com/a.git", path: "packages/signin" }, policy: { installation: "AVAILABLE", authentication: "on_install" } },
      { name: "Ship It", source: "./plugins/duplicate" },
      { name: "Escape", source: "../../../etc" },
      "nonsense",
    ],
  });

  assert.equal(listing.name, "acme-plugins");
  assert.equal(listing.displayName, "Acme");
  assert.deepEqual(listing.plugins.map((plugin) => plugin.name), ["ship-it", "charts", "signin"]);
  assert.deepEqual(listing.plugins[0].source, { kind: "local", path: "plugins/ship-it" });
  assert.equal(listing.plugins[0].category, "Developer tools");
  assert.equal(listing.plugins[0].installation, "AVAILABLE");
  assert.deepEqual(listing.plugins[1].source, { kind: "npm", package: "@acme/charts", version: "", registry: "" });
  assert.deepEqual(listing.plugins[2].source, { kind: "git", url: "https://example.com/a.git", ref: "", path: "packages/signin" });
  assert.equal(listing.plugins[2].authentication, "ON_INSTALL");

  assert.deepEqual(pluginCategories({ marketplaces: [{ ...listing, id: "acme", origin: "", ref: "", sparse: [], local: true, root: "" }], installed: [] }), ["Data and analytics", "Developer tools"]);
  assert.equal(matchesPluginQuery(listing.plugins[0], "DEPLOY"), true);
  assert.equal(matchesPluginQuery(listing.plugins[0], "nothing"), false);
});

test("a plugin manifest defaults its skill and MCP paths and refuses to point outside itself", () => {
  const manifest = parsePluginManifest({ name: "Ship It", interface: { displayName: "Ship It", shortDescription: "Ships." } });
  assert.deepEqual({ ...manifest, interface: undefined }, {
    name: "ship-it", version: "0.0.0", description: "Ships.", displayName: "Ship It", category: "", keywords: [], skills: "skills", mcpServers: ".mcp.json", apps: "", hooks: { paths: [], inline: [] }, interface: undefined,
  });
  assert.equal(parsePluginManifest({ name: "a", skills: "./bundled/skills/" }).skills, "bundled/skills");
  assert.throws(() => parsePluginManifest({ name: "a", skills: "../../../Library" }), /not a path inside the plugin/);
  assert.equal(parsePluginManifest({ name: "a", apps: "./.app.json" }).apps, ".app.json");
  assert.equal(parsePluginManifest({ name: "a", apps: "./connections/acme.json" }).apps, "connections/acme.json");
  assert.throws(() => parsePluginManifest({ name: "a", apps: "../../../Library/apps.json" }), /not a path inside the plugin/);
});

test("a manifest names hooks as one path, a list of paths, an inline object, or a list of those", () => {
  const hooksOf = (value: unknown) => parsePluginManifest({ name: "a", hooks: value }).hooks;
  const inline = { hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo hi", statusMessage: "Loading", timeout: 5 }] }] } };
  const parsed = { event: "SessionStart", matcher: "startup", command: "echo hi", statusMessage: "Loading", timeout: 5 };

  assert.deepEqual(hooksOf(undefined), { paths: [], inline: [] });
  assert.deepEqual(hooksOf("./hooks/session.json"), { paths: ["hooks/session.json"], inline: [] });
  assert.deepEqual(hooksOf(["./hooks/session.json", "./hooks/tools.json"]), { paths: ["hooks/session.json", "hooks/tools.json"], inline: [] });
  assert.deepEqual(hooksOf(inline), { paths: [], inline: [parsed] });
  assert.deepEqual(hooksOf([inline, inline]), { paths: [], inline: [parsed, parsed] });
  assert.deepEqual(hooksOf(["./hooks/session.json", inline]), { paths: ["hooks/session.json"], inline: [parsed] });

  assert.throws(() => hooksOf("../../../Library/hooks.json"), /not a path inside the plugin/);
  assert.throws(() => hooksOf("/etc/hooks.json"), /not a path inside the plugin/);
  assert.throws(() => hooksOf(["./hooks/ok.json", "~/hooks.json"]), /not a path inside the plugin/);
});

test("a hooks file keeps the command handlers Emma understands and says which events she can reach", () => {
  assert.deepEqual(parseHooksFile({ hooks: {
    SessionStart: [{ hooks: [{ type: "command", command: "a" }] }],
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "b", timeout: -4 }] }],
    Nonsense: [{ hooks: [{ type: "command", command: "c" }] }],
    Stop: [{ hooks: [{ type: "prompt", prompt: "d" }, { type: "command" }, "nonsense"] }],
  } }), [
    { event: "SessionStart", matcher: "", command: "a", statusMessage: "", timeout: 0 },
    { event: "PreToolUse", matcher: "Bash", command: "b", statusMessage: "", timeout: 0 },
  ]);
  assert.deepEqual(parseHooksFile({ SessionStart: [{ hooks: [{ type: "command", command: "a" }] }] }), []);
  assert.deepEqual(parseHooksFile("nonsense"), []);
  assert.deepEqual((["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"] as HookEvent[]).map(hookRuns), [true, true, true, true]);
  assert.deepEqual((["PreToolUse", "PostToolUse", "PreCompact", "SubagentStop"] as HookEvent[]).map(hookRuns), [false, false, false, false]);
});

test("an npm plugin source takes a package, a version selector, and an HTTPS registry — and refuses anything argv could read as a flag", () => {
  const npm = (source: Record<string, unknown>) => parseMarketplace({ name: "m", plugins: [{ name: "p", source: { source: "npm", ...source } }] }).plugins[0]?.source;

  assert.deepEqual(npm({ package: "@example/codex-plugin", version: "^1.2.0", registry: "https://registry.npmjs.org" }),
    { kind: "npm", package: "@example/codex-plugin", version: "^1.2.0", registry: "https://registry.npmjs.org" });
  assert.deepEqual(npm({ package: "codex-plugin", version: "next" }), { kind: "npm", package: "codex-plugin", version: "next", registry: "" });
  assert.deepEqual(npm({ package: "codex-plugin", version: ">=1.0.0 <2.0.0" }), { kind: "npm", package: "codex-plugin", version: ">=1.0.0 <2.0.0", registry: "" });

  assert.equal(npm({}), undefined);
  assert.equal(npm({ package: "-rf" }), undefined);
  assert.equal(npm({ package: "../../etc/passwd" }), undefined);
  assert.equal(npm({ package: "Example/Plugin" }), undefined);
  assert.equal(npm({ package: "ok", version: "file:../../etc" }), undefined);
  assert.equal(npm({ package: "ok", version: "./local" }), undefined);
  assert.equal(npm({ package: "ok", version: "git+https://example.com/a.git" }), undefined);
  assert.equal(npm({ package: "ok", version: "--registry=http://evil" }), undefined);
  assert.equal(npm({ package: "ok", registry: "http://registry.npmjs.org" }), undefined);
  assert.equal(npm({ package: "ok", registry: "https://user:pass@registry.npmjs.org" }), undefined);
  assert.equal(npm({ package: "ok", registry: "https://registry.npmjs.org/?token=1" }), undefined);
  assert.equal(npm({ package: "ok", registry: "https://registry.npmjs.org/#f" }), undefined);
  assert.equal(npm({ package: "ok", registry: "javascript:alert(1)" }), undefined);
});

test("a manifest's interface block is parsed whole, and a URL or colour that fails its check is simply absent", () => {
  assert.deepEqual(parsePluginInterface({
    longDescription: "Distribute skills and MCP servers together.",
    developerName: "Your team",
    capabilities: ["Read", "Write"],
    websiteURL: "https://example.com",
    privacyPolicyURL: "https://example.com/privacy",
    termsOfServiceURL: "https://example.com/terms",
    defaultPrompt: ["One.", "Two.", "Three.", "Four."],
    brandColor: "#10A37F",
    composerIcon: "./assets/icon.png",
    logo: "./assets/logo.png",
    screenshots: ["./assets/screenshot-1.png", "./assets/screenshot-2.png"],
  }), {
    longDescription: "Distribute skills and MCP servers together.",
    developerName: "Your team",
    capabilities: ["Read", "Write"],
    websiteURL: "https://example.com/",
    privacyPolicyURL: "https://example.com/privacy",
    termsOfServiceURL: "https://example.com/terms",
    defaultPrompt: ["One.", "Two.", "Three."],
    brandColor: "#10a37f",
    composerIcon: "assets/icon.png",
    logo: "assets/logo.png",
    screenshots: ["assets/screenshot-1.png", "assets/screenshot-2.png"],
  });

  const rejected = parsePluginInterface({
    websiteURL: "javascript:alert(1)",
    privacyPolicyURL: "file:///etc/passwd",
    termsOfServiceURL: "data:text/html,<script>",
    brandColor: "red; background: url(x)",
  });
  assert.deepEqual([rejected.websiteURL, rejected.privacyPolicyURL, rejected.termsOfServiceURL, rejected.brandColor], ["", "", "", ""]);
  assert.equal(parsePluginInterface({ brandColor: "#ABC" }).brandColor, "#abc");
  assert.equal(parsePluginInterface({ brandColor: "#12345" }).brandColor, "");
  assert.throws(() => parsePluginInterface({ logo: "../../../Library/icon.png" }), /not a path inside the plugin/);
  assert.deepEqual(parsePluginInterface(undefined).screenshots, []);
});

test("an .app.json carries ChatGPT-hosted app ids, not servers Emma can run", () => {
  assert.deepEqual(parseHostedApps({ apps: { support: { id: "plugin_asdk_app_6a4c0062", category: "productivity" }, other: { id: "plugin_asdk_app_ff01" } } }), [
    { name: "support", id: "plugin_asdk_app_6a4c0062", category: "Productivity" },
    { name: "other", id: "plugin_asdk_app_ff01", category: "" },
  ]);
  assert.deepEqual(parseHostedApps({ apps: { a: { id: "same" }, b: { id: "same" }, c: {}, d: "nonsense" } }), [{ name: "a", id: "same", category: "" }]);
  assert.deepEqual(parseHostedApps({ docs: { command: "docs-mcp", args: [] } }), []);
  assert.deepEqual(parseHostedApps("nonsense"), []);
});

test("an asset is trusted for what its bytes say, not what its name says", () => {
  assert.equal(imageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])), "image/png");
  assert.equal(imageType(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(8)])), "image/jpeg");
  assert.equal(imageType(Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(8)])), "image/gif");
  assert.equal(imageType(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")])), "image/webp");
  assert.equal(imageType(Buffer.from("<svg onload=alert(1)></svg>")), "");
  assert.equal(imageType(Buffer.from("#!/bin/sh\nrm -rf /\n")), "");
  assert.equal(imageType(Buffer.from([0x89, 0x50, 0x4e])), "");
});

test("a plugin's .mcp.json is read whether or not it wraps its servers", () => {
  const bare = parseMcpConfig(JSON.stringify({ notes: { command: "npx", args: ["-y", "notes-mcp"] } }), ".mcp.json", "plugin:acme/ship-it");
  assert.deepEqual(bare.map((server) => server.name), ["notes"]);
  assert.deepEqual(parseMcpConfig(JSON.stringify({ mcp_servers: { notes: { command: "npx", args: [] } } })).map((server) => server.name), ["notes"]);
  assert.deepEqual(parseMcpConfig(JSON.stringify({ projects: { "/Users/a": { allowedTools: [] } } })), []);
});

const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function seedMarketplace(root: string) {
  const plugin = path.join(root, "plugins", "ship-it");
  await mkdir(path.join(plugin, ".codex-plugin"), { recursive: true });
  await mkdir(path.join(plugin, "skills", "deploy"), { recursive: true });
  await mkdir(path.join(plugin, "assets"), { recursive: true });
  await mkdir(path.join(root, ".agents", "plugins"), { recursive: true });
  await writeFile(path.join(plugin, "assets", "icon.png"), PNG_1X1);
  await writeFile(path.join(plugin, "assets", "shot.png"), PNG_1X1);
  await writeFile(path.join(plugin, "assets", "fake.png"), "<svg onload=alert(1)></svg>");
  await writeFile(path.join(plugin, ".app.json"), JSON.stringify({ apps: { support: { id: "plugin_asdk_app_6a4c0062", category: "Productivity" } } }));
  await writeFile(path.join(plugin, ".codex-plugin", "plugin.json"), JSON.stringify({
    name: "ship-it",
    version: "2.1.0",
    description: "Ships things.",
    apps: "./.app.json",
    interface: {
      longDescription: "Tags, pushes, and tells the room.",
      developerName: "Acme",
      capabilities: ["Read", "Write"],
      websiteURL: "https://example.com",
      privacyPolicyURL: "javascript:alert(1)",
      defaultPrompt: ["Ship the release."],
      brandColor: "#10A37F",
      composerIcon: "./assets/icon.png",
      logo: "./assets/fake.png",
      screenshots: ["./assets/shot.png", "./assets/fake.png"],
    },
  }));
  await writeFile(path.join(plugin, "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: Ship it.\n---\nTag, then push.");
  await writeFile(path.join(plugin, ".mcp.json"), JSON.stringify({ notes: { command: "npx", args: ["-y", "notes-mcp"] } }));
  await writeFile(path.join(root, ".agents", "plugins", "marketplace.json"), JSON.stringify({
    name: "acme",
    interface: { displayName: "Acme" },
    plugins: [{ name: "ship-it", description: "Ships things.", category: "Developer tools", source: "./plugins/ship-it" }],
  }));
}

test("the marketplace Emma ships with is added once, and stays gone once it is removed", async () => {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "emma-plugins-")));
  try {
    const userData = path.join(home, "user-data");
    const shared = path.join(home, "acme");
    await mkdir(userData, { recursive: true });
    await seedMarketplace(shared);

    const first = await ensureDefaultMarketplace(userData, shared);
    assert.deepEqual(first.marketplaces.map((entry) => entry.id), ["acme"]);
    assert.deepEqual((await ensureDefaultMarketplace(userData, shared)).marketplaces.map((entry) => entry.id), ["acme"]);

    await removeMarketplace(userData, "acme");
    assert.deepEqual((await ensureDefaultMarketplace(userData, shared)).marketplaces, []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("adding a local marketplace, installing from it, and removing it moves the plugin's skills and servers in and out of Emma's capabilities", async () => {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "emma-plugins-")));
  try {
    const userData = path.join(home, "user-data");
    const shared = path.join(home, "acme");
    await mkdir(userData, { recursive: true });
    await seedMarketplace(shared);

    const added = await addMarketplace(userData, { source: shared });
    assert.deepEqual(added.marketplaces.map((entry) => [entry.id, entry.displayName, entry.local]), [["acme", "Acme", true]]);
    assert.deepEqual(added.marketplaces[0].plugins.map((entry) => entry.name), ["ship-it"]);
    assert.deepEqual(added.installed, []);
    assert.equal(added.marketplaces[0].plugins[0].brandColor, "#10a37f");
    assert.equal(added.marketplaces[0].plugins[0].icon, `data:image/png;base64,${PNG_1X1.toString("base64")}`);

    const detail = await pluginDetail(userData, "acme", "ship-it");
    assert.equal(detail.interface.longDescription, "Tags, pushes, and tells the room.");
    assert.equal(detail.interface.websiteURL, "https://example.com/");
    assert.equal(detail.interface.privacyPolicyURL, "");
    assert.equal(detail.icon.startsWith("data:image/png;base64,"), true);
    assert.equal(detail.logo, "");
    assert.equal(detail.screenshots.length, 1);
    assert.deepEqual(detail.apps, [{ name: "support", id: "plugin_asdk_app_6a4c0062", category: "Productivity" }]);
    await assert.rejects(addMarketplace(userData, { source: shared }), /already added/);
    await assert.rejects(addMarketplace(userData, { source: path.join(home, "nowhere") }), /no folder at/);

    const installed = await installPlugin(userData, "acme", "ship-it");
    const [record] = installed.installed;
    assert.equal(record.id, "acme/ship-it");
    assert.equal(record.version, "2.1.0");
    assert.equal(record.category, "Developer tools");
    assert.deepEqual(record.skills, [path.join(shared, "plugins", "ship-it", "skills")]);
    assert.deepEqual(record.mcpServers, [path.join(shared, "plugins", "ship-it", ".mcp.json")]);
    assert.deepEqual(record.apps, [{ name: "support", id: "plugin_asdk_app_6a4c0062", category: "Productivity" }]);
    assert.deepEqual((await readCatalog(userData)).installed[0].apps, record.apps);
    assert.deepEqual(await installedCapabilitySources(userData), [{ id: "plugin:acme/ship-it", skillRoots: record.skills, mcpFiles: record.mcpServers }]);

    const harnessHome = path.join(userData, "harness");
    assert.deepEqual(await mirrorSkillsToHarness(userData, harnessHome), ["deploy"]);
    assert.equal(await readFile(path.join(harnessHome, ".fx", "skills", "deploy", "SKILL.md"), "utf8"), "---\nname: deploy\ndescription: Ship it.\n---\nTag, then push.");

    await assert.rejects(installPlugin(userData, "acme", "missing"), /does not list a plugin/);
    await assert.rejects(installPlugin(userData, "nope", "ship-it"), /not tracking a marketplace/);

    assert.deepEqual((await uninstallPlugin(userData, "acme/ship-it")).installed, []);
    assert.deepEqual(await mirrorSkillsToHarness(userData, harnessHome), []);
    assert.deepEqual(await readdir(path.join(harnessHome, ".fx", "skills")), []);
    await assert.rejects(uninstallPlugin(userData, "acme/ship-it"), /No plugin called/);

    await installPlugin(userData, "acme", "ship-it");
    const removed = await removeMarketplace(userData, "acme");
    assert.deepEqual(removed, { marketplaces: [], installed: [] });
    assert.deepEqual(await installedCapabilitySources(userData), []);
    assert.equal(await readFile(path.join(shared, ".agents", "plugins", "marketplace.json"), "utf8") !== "", true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a skill installed by the harness appears immediately and survives imported-skill mirroring", async () => {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "emma-harness-skill-")));
  try {
    const userData = path.join(home, "user-data");
    const harnessHome = path.join(userData, "harness");
    const directory = path.join(harnessHome, ".fx", "skills", "ponytail");
    const content = "---\nname: ponytail\ndescription: Keep it simple.\n---\n\nUse the smallest working change.\n";
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "SKILL.md"), content);

    const skills = await searchImportedSkills(userData, "pony", 64);
    assert.deepEqual(skills, [{ id: "skill:installed:0:ponytail", source: "installed", name: "ponytail" }]);
    assert.equal((await loadImportedSkill(userData, skills[0].id)).instructions, content);
    assert.deepEqual(await mirrorSkillsToHarness(userData, harnessHome), ["ponytail"]);
    assert.equal(await readFile(path.join(directory, "SKILL.md"), "utf8"), content);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

async function seedHookPlugin(root: string, hooks: unknown) {
  const plugin = path.join(root, "plugins", "watcher");
  await mkdir(path.join(plugin, "hooks"), { recursive: true });
  await mkdir(path.join(plugin, ".codex-plugin"), { recursive: true });
  await mkdir(path.join(root, ".agents", "plugins"), { recursive: true });
  await writeFile(path.join(plugin, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "watcher", version: "1.0.0", description: "Watches." }));
  await writeFile(path.join(plugin, "hooks", "hooks.json"), JSON.stringify({ hooks }));
  await writeFile(path.join(root, ".agents", "plugins", "marketplace.json"), JSON.stringify({
    name: "hooked",
    plugins: [{ name: "watcher", description: "Watches.", source: "./plugins/watcher" }],
  }));
  return plugin;
}

test("an npm package that unpacks larger than its ceiling is stopped before it fills the disk", async () => {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "emma-unpack-")));
  try {
    await mkdir(path.join(home, "package"), { recursive: true });
    await writeFile(path.join(home, "package", "index.js"), "x".repeat(64 * 1024));
    const tarball = path.join(home, "bundle.tgz");
    execFileSync("tar", ["-czf", tarball, "-C", home, "package"]);

    const roomy = path.join(home, "roomy");
    await mkdir(roomy, { recursive: true });
    await unpack(tarball, roomy);
    assert.equal((await readFile(path.join(roomy, "package", "index.js"), "utf8")).length, 64 * 1024);

    const tight = path.join(home, "tight");
    await mkdir(tight, { recursive: true });
    await assert.rejects(unpack(tarball, tight, 4096), /unpacks to more than/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

const sessionStart = (command: string, matcher = "startup|resume", extra: Record<string, unknown> = {}) =>
  ({ SessionStart: [{ matcher, hooks: [{ type: "command", command, statusMessage: "Waking up", ...extra }] }] });

test("a plugin's hooks stay off until they are reviewed, run once trusted, and lose that trust the moment the definition changes", async () => {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "emma-hooks-")));
  try {
    const userData = path.join(home, "user-data");
    const shared = path.join(home, "hooked");
    const fired = path.join(home, "fired.log");
    await mkdir(userData, { recursive: true });
    const root = await seedHookPlugin(shared, {
      ...sessionStart(`printf 'x' >> "${fired}"; printf '%s' "$CLAUDE_PLUGIN_ROOT" > "$PLUGIN_DATA/root.txt"`),
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "printf 'never' >> \"" + fired + "\"" }] }],
    });
    const input = { source: "startup", cwd: home };

    await addMarketplace(userData, { source: shared });
    const installed = (await installPlugin(userData, "hooked", "watcher")).installed[0];
    assert.deepEqual(installed.hooks.map((hook) => [hook.event, hook.trusted]), [["SessionStart", false], ["PreToolUse", false]]);
    assert.equal(installed.hooks[0].statusMessage, "Waking up");
    assert.equal(installed.hooks.filter((hook) => hookRuns(hook.event)).length, 1);

    assert.deepEqual(await runPluginHooks(userData, "SessionStart", input), []);
    assert.equal(existsSync(fired), false);

    const trusted = await trustPluginHooks(userData, "hooked/watcher", true);
    assert.deepEqual(trusted.installed[0].hooks.map((hook) => hook.trusted), [true, true]);
    // The phone writes through setHookTrust, which skips the catalogue read on the way back; the
    // record it leaves has to be the one trustPluginHooks would have written.
    await setHookTrust(userData, "hooked/watcher", null);
    assert.deepEqual((await readCatalog(userData)).installed[0].hooks.map((hook) => hook.trusted), [false, false]);
    await setHookTrust(userData, "hooked/watcher", trusted.installed[0].hooks.map((hook) => hook.hash));
    assert.deepEqual((await readCatalog(userData)).installed[0].hooks.map((hook) => hook.trusted), [true, true]);
    assert.deepEqual(await runPluginHooks(userData, "SessionStart", input), []);
    assert.equal(await readFile(fired, "utf8"), "x");
    assert.equal(await readFile(path.join(userData, "plugin-data", "hooked", "watcher", "root.txt"), "utf8"), root);

    assert.deepEqual(await runPluginHooks(userData, "SessionStart", { source: "compact", cwd: home }), []);
    assert.equal(await readFile(fired, "utf8"), "x");

    await writeFile(path.join(root, "hooks", "hooks.json"), JSON.stringify({ hooks: sessionStart(`printf 'y' >> "${fired}"`) }));
    assert.deepEqual((await readCatalog(userData)).installed[0].hooks.map((hook) => hook.trusted), [false]);
    assert.deepEqual(await runPluginHooks(userData, "SessionStart", input), []);
    assert.equal(await readFile(fired, "utf8"), "x");

    await trustPluginHooks(userData, "hooked/watcher", false);
    await writeFile(path.join(root, "hooks", "hooks.json"), JSON.stringify({ hooks: sessionStart("printf 'no such thing' >&2; exit 3") }));
    await trustPluginHooks(userData, "hooked/watcher", true);
    assert.deepEqual(await runPluginHooks(userData, "SessionStart", input), ["watcher · SessionStart hook exited 3 — no such thing"]);

    const leaked = path.join(home, "leaked");
    await writeFile(path.join(root, "hooks", "hooks.json"), JSON.stringify({ hooks: sessionStart(`(sleep 2; printf 'leak' > "${leaked}") & wait`, "startup|resume", { timeout: 1 }) }));
    await trustPluginHooks(userData, "hooked/watcher", true);
    assert.deepEqual(await runPluginHooks(userData, "SessionStart", input), ["watcher · SessionStart hook ran past 1s and was stopped"]);
    await new Promise((done) => setTimeout(done, 2500));
    assert.equal(existsSync(leaked), false);

    await uninstallPlugin(userData, "hooked/watcher");
    assert.deepEqual(await runPluginHooks(userData, "SessionStart", input), []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a plugin root that reads like a shell command is expanded as a value, never as a second command", async () => {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "emma-hook-escape-")));
  try {
    const userData = path.join(home, "user-data");
    const pwned = path.join(home, "pwned");
    const shared = path.join(home, `store; touch ${pwned} #`);
    await mkdir(userData, { recursive: true });
    const root = await seedHookPlugin(shared, sessionStart(
      'printf "%s" "${PLUGIN_ROOT}" > "$PLUGIN_DATA/quoted.txt"; printf "%s" ${PLUGIN_ROOT} > "$PLUGIN_DATA/bare.txt"',
    ));

    await addMarketplace(userData, { source: shared });
    await installPlugin(userData, "hooked", "watcher");
    await trustPluginHooks(userData, "hooked/watcher", true);
    assert.deepEqual(await runPluginHooks(userData, "SessionStart", { source: "startup", cwd: home }), []);

    const data = path.join(userData, "plugin-data", "hooked", "watcher");
    assert.equal(await readFile(path.join(data, "quoted.txt"), "utf8"), root);
    assert.equal(existsSync(path.join(data, "bare.txt")), true);
    assert.equal(existsSync(pwned), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a plugin Emma writes lands in her own marketplace, installed, with usable SKILL.md frontmatter", async () => {
  const userData = await realpath(await mkdtemp(path.join(tmpdir(), "emma-authored-")));
  try {
    const { catalog, plugin } = await writePlugin(userData, {
      name: "Standup Notes",
      description: "Turns a week of commits into a standup.",
      category: "productivity",
      skills: [{ name: "Weekly Standup", description: "Summarise the week.", instructions: "Read the log, group by day." }],
    });

    assert.equal(plugin.name, "standup-notes");
    assert.equal(await readFile(path.join(plugin.root, "skills", "weekly-standup", "SKILL.md"), "utf8"),
      '---\nname: weekly-standup\ndescription: "Summarise the week."\n---\n\nRead the log, group by day.');
    assert.deepEqual(catalog.marketplaces.map((entry) => entry.displayName), ["Written by Emma"]);
    assert.deepEqual(catalog.installed.map((entry) => [entry.id, entry.category]), [["emma/standup-notes", "Productivity"]]);
    assert.deepEqual(await installedCapabilitySources(userData), [{
      id: "plugin:emma/standup-notes",
      skillRoots: [path.join(plugin.root, "skills")],
      mcpFiles: [],
    }]);

    const second = await writePlugin(userData, { name: "Release Notes", description: "Drafts release notes.", skills: [{ name: "draft", description: "", instructions: "---\nname: draft\n---\nDraft it." }] });
    assert.deepEqual((await readCatalog(userData)).marketplaces[0].plugins.map((entry) => entry.name).sort(), ["release-notes", "standup-notes"]);
    assert.equal(await readFile(path.join(second.plugin.root, "skills", "draft", "SKILL.md"), "utf8"), "---\nname: draft\n---\nDraft it.");

    await assert.rejects(writePlugin(userData, { name: "no-skills", description: "Nothing." }), /at least one skill/);
    await assert.rejects(writePlugin(userData, { name: "no-blurb", skills: [{ name: "a", instructions: "b" }] }), /one-line description/);
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
});
