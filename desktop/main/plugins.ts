import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

export type UiPlugin = { id: string; name: string; version: string; css: string };

function pluginManifest(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("plugin manifest must be an object");
  const manifest = value as Record<string, unknown>;
  if (typeof manifest.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.id) || manifest.id.length > 64) throw new Error("plugin id is invalid");
  if (typeof manifest.name !== "string" || !manifest.name.trim() || manifest.name.length > 128) throw new Error("plugin name is invalid");
  if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error("plugin version is invalid");
  if (typeof manifest.uiStylesheet !== "string" || path.basename(manifest.uiStylesheet) !== manifest.uiStylesheet || !manifest.uiStylesheet.endsWith(".css")) throw new Error("plugin stylesheet is invalid");
  return { id: manifest.id, name: manifest.name, version: manifest.version, uiStylesheet: manifest.uiStylesheet };
}

export function validatePluginCss(value: string) {
  if (value.length > 128 * 1024 || /@import\b|url\s*\(/i.test(value)) throw new Error("plugin stylesheet uses a blocked resource");
  return value;
}

export async function loadUiPlugins(userData: string): Promise<UiPlugin[]> {
  const root = path.join(userData, "plugins");
  const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
  const plugins: UiPlugin[] = [];
  for (const entry of entries.slice(0, 32)) {
    if (!entry.isDirectory()) continue;
    try {
      const directory = path.join(root, entry.name);
      const manifestPath = path.join(directory, "plugin.json");
      if ((await stat(manifestPath)).size > 32 * 1024) throw new Error("plugin manifest is too large");
      const manifest = pluginManifest(JSON.parse(await readFile(manifestPath, "utf8")));
      if (manifest.id !== entry.name) throw new Error("plugin directory must match its id");
      const stylesheet = await realpath(path.join(directory, manifest.uiStylesheet));
      const realDirectory = await realpath(directory);
      if (!stylesheet.startsWith(`${realDirectory}${path.sep}`) || (await stat(stylesheet)).size > 128 * 1024) throw new Error("plugin stylesheet is outside its plugin");
      plugins.push({ id: manifest.id, name: manifest.name, version: manifest.version, css: validatePluginCss(await readFile(stylesheet, "utf8")) });
    } catch (error) {
      console.warn(`Emma skipped UI plugin ${entry.name}:`, error instanceof Error ? error.message : error);
    }
  }
  return plugins;
}
