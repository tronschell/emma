import { mkdir, readdir, stat, writeFile, rename } from "node:fs/promises";
import path from "node:path";

export type ImportSource = {
  id: string;
  label: string;
  mark: string;
  skillRoots: string[];
  mcpFiles: string[];
};

export type ImportDiscovery = Pick<ImportSource, "id" | "label" | "mark"> & {
  skills: number;
  mcpConfigs: number;
  locations: string[];
};

export function importSources(home: string): ImportSource[] {
  const at = (...parts: string[]) => path.join(home, ...parts);
  return [
    { id: "codex", label: "Codex", mark: "◎", skillRoots: [at(".codex", "skills")], mcpFiles: [at(".codex", "config.toml")] },
    { id: "claude", label: "Claude", mark: "A", skillRoots: [at(".claude", "skills")], mcpFiles: [at(".claude.json")] },
    { id: "antigravity", label: "Antigravity", mark: "G", skillRoots: [at(".gemini", "antigravity", "skills")], mcpFiles: [at(".gemini", "antigravity", "mcp_config.json")] },
    { id: "pi", label: "Pi", mark: "π", skillRoots: [at(".pi", "agent", "skills")], mcpFiles: [at(".pi", "agent", "settings.json")] },
    { id: "opencode", label: "OpenCode", mark: "O", skillRoots: [at(".config", "opencode", "skills"), at(".opencode", "skills")], mcpFiles: [at(".config", "opencode", "opencode.json"), at(".config", "opencode", "opencode.jsonc")] },
    { id: "cursor", label: "Cursor", mark: "C", skillRoots: [at(".cursor", "skills")], mcpFiles: [at(".cursor", "mcp.json")] },
    { id: "windsurf", label: "Windsurf", mark: "W", skillRoots: [at(".windsurf", "skills")], mcpFiles: [at(".codeium", "windsurf", "mcp_config.json")] },
    { id: "devin", label: "Devin", mark: "D", skillRoots: [at(".devin", "skills")], mcpFiles: [at(".devin", "mcp.json")] },
  ];
}

async function exists(value: string) {
  try { await stat(value); return true; } catch { return false; }
}

async function skillCount(root: string) {
  if (!await exists(root)) return 0;
  const entries = await readdir(root, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    if ((entry.isDirectory() || entry.isSymbolicLink()) && await exists(path.join(root, entry.name, "SKILL.md"))) count += 1;
  }
  return count;
}

export async function discoverImports(home: string): Promise<ImportDiscovery[]> {
  const sources = importSources(home);
  return Promise.all(sources.map(async (source) => {
    const skillRoots = await Promise.all(source.skillRoots.map(async (root) => ({ root, count: await skillCount(root) })));
    const mcpFiles = (await Promise.all(source.mcpFiles.map(async (file) => ({ file, exists: await exists(file) })))).filter((item) => item.exists);
    return {
      id: source.id,
      label: source.label,
      mark: source.mark,
      skills: skillRoots.reduce((sum, item) => sum + item.count, 0),
      mcpConfigs: mcpFiles.length,
      locations: [...skillRoots.filter((item) => item.count).map((item) => item.root.replace(home, "~")), ...mcpFiles.map((item) => item.file.replace(home, "~"))],
    };
  }));
}

export async function saveImportManifest(userData: string, home: string, ids: string[]) {
  const selected = importSources(home).filter((source) => ids.includes(source.id));
  if (selected.length !== new Set(ids).size) throw new Error("Import selection is invalid");
  const sources = [];
  for (const source of selected) {
    const skillRoots = [];
    for (const root of source.skillRoots) if (await exists(root)) skillRoots.push(root);
    const mcpFiles = [];
    for (const file of source.mcpFiles) if (await exists(file)) mcpFiles.push(file);
    if (skillRoots.length || mcpFiles.length) sources.push({ id: source.id, skillRoots, mcpFiles });
  }
  await mkdir(userData, { recursive: true });
  const destination = path.join(userData, "imports.json");
  const temporary = `${destination}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ version: 1, importedAt: new Date().toISOString(), sources }, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, destination);
  return sources.map((source) => source.id);
}
