import { contextBridge, ipcRenderer } from "electron";

let nextListener = 1;
const listeners = new Map<number, () => void>();

contextBridge.exposeInMainWorld("emma", {
  request: (method: string, params: Record<string, string> = {}) =>
    ipcRenderer.invoke("emma:request", { method, params }),
  setOverlayPreferences: (value: unknown) => ipcRenderer.send("emma:set-overlay-preferences", value),
  setOverlayMousePassthrough: (value: boolean) => ipcRenderer.send("emma:set-overlay-mouse-passthrough", value),
  setOverlayBusy: (value: boolean) => ipcRenderer.send("emma:set-overlay-busy", value),
  startScreenAnnotation: () => ipcRenderer.invoke("emma:start-screen-annotation"),
  getScreenAnnotationFrame: () => ipcRenderer.invoke("emma:get-screen-annotation-frame"),
  finishScreenAnnotation: (strokes: unknown) => ipcRenderer.invoke("emma:finish-screen-annotation", strokes),
  cancelScreenAnnotation: () => ipcRenderer.invoke("emma:cancel-screen-annotation"),
  screenAnnotationStatus: () => ipcRenderer.invoke("emma:screen-annotation-status"),
  clearScreenAnnotation: (id: string) => ipcRenderer.invoke("emma:clear-screen-annotation", id),
  discoverAgentImports: () => ipcRenderer.invoke("emma:discover-agent-imports"),
  importAgentSources: (ids: string[]) => ipcRenderer.invoke("emma:import-agent-sources", ids),
  searchImportedSkills: (value: { query: string; limit?: number }) => ipcRenderer.invoke("emma:search-imported-skills", value),
  selectImportedSkill: (value: { id: string; threadId: string }) => ipcRenderer.invoke("emma:select-imported-skill", value),
  importedSkillStatus: () => ipcRenderer.invoke("emma:imported-skill-status"),
  clearImportedSkill: (id: string) => ipcRenderer.invoke("emma:clear-imported-skill", id),
  listImportedMcpServers: () => ipcRenderer.invoke("emma:list-imported-mcp-servers"),
  reviewImportedMcpServer: (id: string) => ipcRenderer.invoke("emma:review-imported-mcp-server", id),
  connectImportedMcpServer: (value: { serverId: string; token: string }) => ipcRenderer.invoke("emma:connect-imported-mcp-server", value),
  searchMcpTools: (value: { query: string; limit?: number }) => ipcRenderer.invoke("emma:search-mcp-tools", value),
  selectMcpTool: (name: string) => ipcRenderer.invoke("emma:select-mcp-tool", name),
  callMcpTool: (argsJson: string) => ipcRenderer.invoke("emma:call-mcp-tool", argsJson),
  closeImportedMcpServer: () => ipcRenderer.invoke("emma:close-imported-mcp-server"),
  loadUiPlugins: () => ipcRenderer.invoke("emma:load-ui-plugins"),
  onChanged: (listener: () => void) => {
    const id = nextListener++;
    const wrapped = () => listener();
    listeners.set(id, wrapped);
    ipcRenderer.on("emma:changed", wrapped);
    return id;
  },
  offChanged: (id: number) => {
    const listener = listeners.get(id);
    if (listener) ipcRenderer.removeListener("emma:changed", listener);
    listeners.delete(id);
  },
});
