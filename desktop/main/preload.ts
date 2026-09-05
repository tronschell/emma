import { contextBridge, ipcRenderer } from "electron";
import type { ThreadStep } from "../shared/agents";
import type { KeepRequest, VaultKind } from "../shared/vault";
import type { GoalStatus } from "../shared/goal";
import type { CouncilStart, CouncilState } from "../shared/council";
import type { ShortcutRequest, VerifierSettings } from "../shared/settings";

let nextListener = 1;
const listeners = new Map<number, () => void>();

const platform = typeof process === "object" && typeof process.platform === "string" ? process.platform : typeof navigator === "object" && /Windows/i.test(navigator.userAgent) ? "win32" : "darwin";

contextBridge.exposeInMainWorld("emma", {
  platform,
  request: (method: string, params: Record<string, string> = {}) =>
    ipcRenderer.invoke("emma:request", { method, params }),
  setOverlayPreferences: (value: unknown) => ipcRenderer.send("emma:set-overlay-preferences", value),
  setOverlayBusy: (value: boolean) => ipcRenderer.send("emma:set-overlay-busy", value),
  setKeybinds: (value: unknown) => ipcRenderer.invoke("emma:set-keybinds", value),
  onShortcutRequest: (listener: (value: ShortcutRequest & { id: string }) => void) => {
    const wrapped = (_event: unknown, value: unknown) => {
      const request = value as Partial<ShortcutRequest> & { id?: unknown };
      if (typeof request.id === "string" && typeof request.accelerator === "string" && typeof request.label === "string" && typeof request.prompt === "string") listener(request as ShortcutRequest & { id: string });
    };
    ipcRenderer.on("emma:shortcut-request", wrapped);
    return () => ipcRenderer.removeListener("emma:shortcut-request", wrapped);
  },
  completeShortcutRequest: (value: unknown) => ipcRenderer.invoke("emma:complete-shortcut-request", value),
  openOverlay: () => ipcRenderer.send("emma:open-overlay"),
  setOverlayHeight: (value: number) => ipcRenderer.send("emma:set-overlay-height", value),
  onOverlaySurface: (listener: (value: "notch" | "pill" | "popout") => void) => {
    const wrapped = (_event: unknown, value: unknown) => { if (value === "notch" || value === "pill" || value === "popout") listener(value); };
    ipcRenderer.on("emma:overlay-surface", wrapped);
    return () => ipcRenderer.removeListener("emma:overlay-surface", wrapped);
  },
  movePill: (value: { x: number; y: number }) => ipcRenderer.send("emma:move-pill", value),
  expandPill: () => ipcRenderer.send("emma:expand-pill"),
  dismissOverlay: () => ipcRenderer.send("emma:dismiss-overlay"),
  openWorkspace: (settingsPage?: string) => ipcRenderer.send("emma:open-workspace", settingsPage),
  resyncWindow: () => ipcRenderer.send("emma:resync-window"),
  voiceStatus: (settings: unknown) => ipcRenderer.invoke("emma:voice-status", settings),
  transcribe: (value: { audio: ArrayBuffer; mimeType: string; settings: unknown }) => ipcRenderer.invoke("emma:transcribe", value),
  onOpenSettings: (listener: (page: string) => void) => {
    const wrapped = (_event: unknown, value: unknown) => { if (typeof value === "string") listener(value); };
    ipcRenderer.on("emma:open-settings", wrapped);
    return () => ipcRenderer.removeListener("emma:open-settings", wrapped);
  },
  sendQuickCommand: (value: string) => ipcRenderer.send("emma:quick-command", value),
  onQuickCommand: (listener: (value: string) => void) => {
    const wrapped = (_event: unknown, value: unknown) => { if (typeof value === "string") listener(value); };
    ipcRenderer.on("emma:quick-command", wrapped);
    return () => ipcRenderer.removeListener("emma:quick-command", wrapped);
  },
  onNewQuickSession: (listener: () => void) => {
    const wrapped = () => listener();
    ipcRenderer.on("emma:new-quick-session", wrapped);
    return () => ipcRenderer.removeListener("emma:new-quick-session", wrapped);
  },
  onNotchHover: (listener: (value: boolean) => void) => {
    const wrapped = (_event: unknown, value: unknown) => listener(value === true);
    ipcRenderer.on("emma:notch-hover", wrapped);
    return () => ipcRenderer.removeListener("emma:notch-hover", wrapped);
  },
  updateReady: () => ipcRenderer.invoke("emma:update-ready"),
  installUpdate: () => ipcRenderer.invoke("emma:install-update"),
  onUpdateReady: (listener: (value: string) => void) => {
    const wrapped = (_event: unknown, value: unknown) => { if (typeof value === "string") listener(value); };
    ipcRenderer.on("emma:update-ready", wrapped);
    return () => ipcRenderer.removeListener("emma:update-ready", wrapped);
  },
  onDelta: (listener: (value: { threadId: string; delta: string; thinking?: boolean; recovery?: boolean }) => void) => {
    const wrapped = (_event: unknown, value: unknown) => {
      const chunk = value as { threadId?: unknown; delta?: unknown; thinking?: unknown; recovery?: unknown };
      if (typeof chunk?.threadId === "string" && typeof chunk.delta === "string") listener({ threadId: chunk.threadId, delta: chunk.delta, thinking: chunk.thinking === true, recovery: chunk.recovery === true });
    };
    ipcRenderer.on("emma:delta", wrapped);
    return () => ipcRenderer.removeListener("emma:delta", wrapped);
  },
  onStep: (listener: (value: ThreadStep) => void) => {
    const wrapped = (_event: unknown, value: unknown) => {
      const step = value as Partial<ThreadStep>;
      if (typeof step?.threadId === "string" && typeof step.toolCallId === "string") listener(step as ThreadStep);
    };
    ipcRenderer.on("emma:step", wrapped);
    return () => ipcRenderer.removeListener("emma:step", wrapped);
  },
  onCompacted: (listener: (value: { threadId: string; removedTurns: number; summaryChars: number; modelWritten: boolean }) => void) => {
    const wrapped = (_event: unknown, value: unknown) => {
      const compacted = value as { threadId?: unknown; removedTurns?: unknown; summaryChars?: unknown; modelWritten?: unknown };
      if (typeof compacted?.threadId === "string") listener({ threadId: compacted.threadId, removedTurns: Number(compacted.removedTurns) || 0, summaryChars: Number(compacted.summaryChars) || 0, modelWritten: compacted.modelWritten === true });
    };
    ipcRenderer.on("emma:compacted", wrapped);
    return () => ipcRenderer.removeListener("emma:compacted", wrapped);
  },
  onContextExperiment: (listener: (value: { threadId: string; prunedResults: number; reinjected: boolean; savedTokens: number; addedTokens: number }) => void) => {
    const wrapped = (_event: unknown, value: unknown) => {
      const fired = value as { threadId?: unknown; prunedResults?: unknown; reinjected?: unknown; savedTokens?: unknown; addedTokens?: unknown };
      if (typeof fired?.threadId === "string") listener({ threadId: fired.threadId, prunedResults: Number(fired.prunedResults) || 0, reinjected: fired.reinjected === true, savedTokens: Number(fired.savedTokens) || 0, addedTokens: Number(fired.addedTokens) || 0 });
    };
    ipcRenderer.on("emma:context-experiment", wrapped);
    return () => ipcRenderer.removeListener("emma:context-experiment", wrapped);
  },
  onRoutedModel: (listener: (value: { threadId: string; model: string; fellBack: boolean }) => void) => {
    const wrapped = (_event: unknown, value: unknown) => {
      const routed = value as { threadId?: unknown; model?: unknown; fellBack?: unknown };
      if (typeof routed?.threadId === "string" && typeof routed.model === "string") listener({ threadId: routed.threadId, model: routed.model, fellBack: routed.fellBack === true });
    };
    ipcRenderer.on("emma:routed-model", wrapped);
    return () => ipcRenderer.removeListener("emma:routed-model", wrapped);
  },
  onContextBreakdown:(listener: (value: { threadId: string; systemPromptBytes: number; systemToolsBytes: number; mcpToolsBytes: number; skillsBytes: number; memoryBytes: number }) => void) => {
    const wrapped = (_event: unknown, value: unknown) => {
      const parts = value as { threadId?: unknown; systemPromptBytes?: unknown; systemToolsBytes?: unknown; mcpToolsBytes?: unknown; skillsBytes?: unknown; memoryBytes?: unknown };
      if (typeof parts?.threadId === "string") listener({ threadId: parts.threadId, systemPromptBytes: Number(parts.systemPromptBytes) || 0, systemToolsBytes: Number(parts.systemToolsBytes) || 0, mcpToolsBytes: Number(parts.mcpToolsBytes) || 0, skillsBytes: Number(parts.skillsBytes) || 0, memoryBytes: Number(parts.memoryBytes) || 0 });
    };
    ipcRenderer.on("emma:context-breakdown", wrapped);
    return () => ipcRenderer.removeListener("emma:context-breakdown", wrapped);
  },
  startScreenAnnotation: () => ipcRenderer.invoke("emma:start-screen-annotation"),
  onScreenContext: (listener: (value: { id: string; image: string; source?: { application: string; window: string } } | null) => void) => {
    const wrapped = (_event: unknown, value: unknown) => listener(value === null ? null : value as { id: string; image: string });
    ipcRenderer.on("emma:screen-context", wrapped);
    return () => ipcRenderer.removeListener("emma:screen-context", wrapped);
  },
  captureScreenContext: () => ipcRenderer.invoke("emma:capture-screen-context"),
  getScreenAnnotationFrame: () => ipcRenderer.invoke("emma:get-screen-annotation-frame"),
  finishScreenAnnotation: (annotated: string) => ipcRenderer.invoke("emma:finish-screen-annotation", annotated),
  cancelScreenAnnotation: () => ipcRenderer.invoke("emma:cancel-screen-annotation"),
  screenAnnotationStatus: () => ipcRenderer.invoke("emma:screen-annotation-status"),
  clearScreenAnnotation: (id: string) => ipcRenderer.invoke("emma:clear-screen-annotation", id),
  revealPath: (value: string) => ipcRenderer.invoke("emma:reveal-path", value),
  previewPath: (value: string) => ipcRenderer.invoke("emma:preview-path", value),
  listArtifacts: () => ipcRenderer.invoke("emma:list-artifacts"),
  readArtifact: (id: string) => ipcRenderer.invoke("emma:read-artifact", id),
  saveArtifact: (value: { id?: string; title: string; kind: string; language?: string; content: string }) => ipcRenderer.invoke("emma:save-artifact", value),
  deleteArtifact: (id: string) => ipcRenderer.invoke("emma:delete-artifact", id),
  revealArtifact: (id: string) => ipcRenderer.invoke("emma:reveal-artifact", id),
  artifactSql: (id: string, sql: string, params: unknown[]) => ipcRenderer.invoke("emma:artifact-sql", { id, sql, params }),
  onArtifactsChanged: (listener: () => void) => {
    const wrapped = () => listener();
    ipcRenderer.on("emma:artifacts-changed", wrapped);
    return () => ipcRenderer.removeListener("emma:artifacts-changed", wrapped);
  },
  listComponents: () => ipcRenderer.invoke("emma:list-components"),
  readComponent: (id: string) => ipcRenderer.invoke("emma:read-component", id),
  deleteComponent: (id: string) => ipcRenderer.invoke("emma:delete-component", id),
  enableComponent: (id: string, enabled: boolean) => ipcRenderer.invoke("emma:enable-component", { id, enabled }),
  expandComponent: (value: { id: string; expands: boolean }) => ipcRenderer.invoke("emma:expand-component", value),
  componentFetch: (value: { id: string; request: unknown }) => ipcRenderer.invoke("emma:component-fetch", value),
  shootComponent: (value: { id: string; x: number; y: number; width: number; height: number }) => ipcRenderer.invoke("emma:shoot-component", value),
  onComponentsChanged: (listener: () => void) => {
    const wrapped = () => listener();
    ipcRenderer.on("emma:components-changed", wrapped);
    return () => ipcRenderer.removeListener("emma:components-changed", wrapped);
  },
  readVisual: (id: string) => ipcRenderer.invoke("emma:read-visual", id),
  exportVisual: (id: string, width: number) => ipcRenderer.invoke("emma:export-visual", { id, width }),
  listPlans: () => ipcRenderer.invoke("emma:list-plans"),
  listTaskLists: () => ipcRenderer.invoke("emma:list-task-lists"),
  setGoal: (value: { threadId: string; objective: string; tokenBudget?: number }) => ipcRenderer.invoke("emma:set-goal", value),
  updateGoal: (value: { threadId: string; status?: GoalStatus; evidence?: string; reason?: string; extraTokens?: number }) => ipcRenderer.invoke("emma:update-goal", value),
  clearGoal: (threadId: string) => ipcRenderer.invoke("emma:clear-goal", threadId),
  onPlansChanged: (listener: () => void) => {
    const wrapped = () => listener();
    ipcRenderer.on("emma:plans-changed", wrapped);
    return () => ipcRenderer.removeListener("emma:plans-changed", wrapped);
  },
  onTaskListsChanged: (listener: () => void) => {
    const wrapped = () => listener();
    ipcRenderer.on("emma:task-lists-changed", wrapped);
    return () => ipcRenderer.removeListener("emma:task-lists-changed", wrapped);
  },
  benchJudge: (value: { prompt: string; rubric: string; answer: string; judge?: VerifierSettings }) => ipcRenderer.invoke("emma:bench-judge", value),
  exportBench: (value: { name: string; sheets: { name: string; rows: (string | number)[][] }[] }) => ipcRenderer.invoke("emma:export-bench", value),
  exportThreadStats: (value: { folder: string; files: { name: string; text: string }[] }) => ipcRenderer.invoke("emma:export-thread-stats", value),
  listFolders: () => ipcRenderer.invoke("emma:list-folders"),
  pluginCatalog: () => ipcRenderer.invoke("emma:plugin-catalog"),
  addMarketplace: (value: { source: string; ref: string; sparse: string }) => ipcRenderer.invoke("emma:add-marketplace", value),
  removeMarketplace: (id: string) => ipcRenderer.invoke("emma:remove-marketplace", id),
  refreshMarketplace: (id: string) => ipcRenderer.invoke("emma:refresh-marketplace", id),
  installPlugin: (value: { marketplace: string; plugin: string }) => ipcRenderer.invoke("emma:install-plugin", value),
  uninstallPlugin: (id: string) => ipcRenderer.invoke("emma:uninstall-plugin", id),
  pluginDetail: (value: { marketplace: string; plugin: string }) => ipcRenderer.invoke("emma:plugin-detail", value),
  trustPluginHooks: (value: { id: string; trusted: boolean }) => ipcRenderer.invoke("emma:trust-plugin-hooks", value),
  setupStatus: () => ipcRenderer.invoke("emma:setup-status"),
  openPrivacySettings: (permission: string) => ipcRenderer.invoke("emma:open-privacy-settings", permission),
  demoQuickAsk: () => ipcRenderer.invoke("emma:demo-quick-ask"),
  pickVaultFolder: () => ipcRenderer.invoke("emma:pick-vault-folder"),
  detectVaults: () => ipcRenderer.invoke("emma:detect-vaults"),
  setVault: (value: { kind: VaultKind; name?: string; folder?: string }) => ipcRenderer.invoke("emma:set-vault", value),
  vaultStatus: () => ipcRenderer.invoke("emma:vault-status"),
  installObsidian: () => ipcRenderer.invoke("emma:install-obsidian"),
  keep: (value: KeepRequest) => ipcRenderer.invoke("emma:keep", value),
  keepScreen: (id: string) => ipcRenderer.invoke("emma:keep-screen", id),
  listNotes: () => ipcRenderer.invoke("emma:list-notes"),
  readNote: (value: string) => ipcRenderer.invoke("emma:read-note", value),
  listNoteFolders: () => ipcRenderer.invoke("emma:list-note-folders"),
  createNoteFolder: (name: string) => ipcRenderer.invoke("emma:create-note-folder", name),
  renameNoteFolder: (value: { folder: string; name: string }) => ipcRenderer.invoke("emma:rename-note-folder", value),
  moveNote: (value: { path: string; folder: string }) => ipcRenderer.invoke("emma:move-note", value),
  openInObsidian: (relative: string) => ipcRenderer.invoke("emma:open-in-obsidian", relative),
  onNotesChanged: (listener: () => void) => {
    const wrapped = () => listener();
    ipcRenderer.on("emma:notes-changed", wrapped);
    return () => ipcRenderer.removeListener("emma:notes-changed", wrapped);
  },
  resetData: () => ipcRenderer.invoke("emma:reset-data"),
  pickFolder: () => ipcRenderer.invoke("emma:pick-folder"),
  forgetFolder: (id: string) => ipcRenderer.invoke("emma:forget-folder", id),
  listFolderFiles: (id: string) => ipcRenderer.invoke("emma:list-folder-files", id),
  gitStatus: (id: string) => ipcRenderer.invoke("emma:git-status", id),
  gitReady: (id: string) => ipcRenderer.invoke("emma:git-ready", id),
  gitInit: (id: string) => ipcRenderer.invoke("emma:git-init", id),
  gitHistory: (value: { folderId: string; skip?: number; limit?: number }) => ipcRenderer.invoke("emma:git-history", value),
  gitCommit: (value: { folderId: string; message: string; paths: string[]; amend?: boolean }) => ipcRenderer.invoke("emma:git-commit", value),
  gitDiscard: (value: { folderId: string; paths: string[] }) => ipcRenderer.invoke("emma:git-discard", value),
  gitRun: (value: { folderId: string; args: string[] }) => ipcRenderer.invoke("emma:git-run", value),
  gitMessage: (value: { folderId: string }) => ipcRenderer.invoke("emma:git-message", value),
  mobileStatus: () => ipcRenderer.invoke("emma:mobile-status"),
  mobilePair: (pin: string) => ipcRenderer.invoke("emma:mobile-pair", pin),
  mobileCancelPair: () => ipcRenderer.invoke("emma:mobile-cancel-pair"),
  mobileUnpair: (id?: number) => ipcRenderer.invoke("emma:mobile-unpair", id),
  onMobileStatus: (listener: (value: { paired: boolean; connected: boolean; name: string }) => void) => {
    const wrapped = (_event: unknown, value: unknown) => { if (value && typeof value === "object") listener(value as { paired: boolean; connected: boolean; name: string }); };
    ipcRenderer.on("emma:mobile-status", wrapped);
    return () => ipcRenderer.removeListener("emma:mobile-status", wrapped);
  },
  machineSample: () => ipcRenderer.invoke("emma:machine-sample"),
  listEditors: () => ipcRenderer.invoke("emma:list-editors"),
  openInEditor: (value: { folderId?: string; path: string; editorId: string }) => ipcRenderer.invoke("emma:open-in-editor", value),
  setWorktree: (value: { folderId: string; name: string; on: boolean }) => ipcRenderer.invoke("emma:set-worktree", value),
  worktreeList: (folderId: string) => ipcRenderer.invoke("emma:worktree-list", folderId),
  worktreeAdd: (value: { folderId: string; prefix: string; name: string }) => ipcRenderer.invoke("emma:worktree-add", value),
  worktreeRemove: (value: { folderId: string; paths: string[] }) => ipcRenderer.invoke("emma:worktree-remove", value),
  setBranch: (value: { folderId: string; branch: string; create: boolean; from?: string }) => ipcRenderer.invoke("emma:set-branch", value),
  readFolderFile: (value: { folderId: string; path: string }) => ipcRenderer.invoke("emma:read-folder-file", value),
  attachFiles: () => ipcRenderer.invoke("emma:attach-files"),
  attachData: (value: { name: string; data: ArrayBuffer }) => ipcRenderer.invoke("emma:attach-data", value),
  readAttachment: (id: string) => ipcRenderer.invoke("emma:read-attachment", id),
  clearThreadContext: (threadId: string) => ipcRenderer.invoke("emma:clear-thread-context", threadId),
  discoverAgentImports: () => ipcRenderer.invoke("emma:discover-agent-imports"),
  importAgentSources: (ids: string[]) => ipcRenderer.invoke("emma:import-agent-sources", ids),
  searchImportedSkills: (value: { query: string; limit?: number }) => ipcRenderer.invoke("emma:search-imported-skills", value),
  selectImportedSkill: (value: { id: string; threadId: string }) => ipcRenderer.invoke("emma:select-imported-skill", value),
  importedSkillStatus: () => ipcRenderer.invoke("emma:imported-skill-status"),
  clearImportedSkill: (id: string) => ipcRenderer.invoke("emma:clear-imported-skill", id),
  listImportedMcpServers: () => ipcRenderer.invoke("emma:list-imported-mcp-servers"),
  stopComputerRun: () => ipcRenderer.send("emma:stop-computer-run"),
  onComputerRunProgress: (listener: (value: unknown) => void) => {
    const wrapped = (_event: unknown, value: unknown) => listener(value);
    ipcRenderer.on("emma:computer-run-progress", wrapped);
    ipcRenderer.send("emma:computer-run-ready");
    return () => ipcRenderer.removeListener("emma:computer-run-progress", wrapped);
  },
  setProviders: (value: unknown) => ipcRenderer.invoke("emma:set-providers", value),
  testProvider: (value: unknown) => ipcRenderer.invoke("emma:test-provider", value),
  setDefaultMode: (value: unknown) => ipcRenderer.invoke("emma:set-default-mode", value),
  setVerifier: (value: unknown) => ipcRenderer.invoke("emma:set-verifier", value),
  setToolSettings: (value: unknown) => ipcRenderer.invoke("emma:set-tool-settings", value),
  setZoom: (value: number) => ipcRenderer.invoke("emma:set-zoom", value),
  setTagger: (value: unknown) => ipcRenderer.invoke("emma:set-tagger", value),
  setHarnessExperiments: (value: unknown) => ipcRenderer.invoke("emma:set-harness-experiments", value),
  setReview: (value: unknown) => ipcRenderer.invoke("emma:set-review", value),
  setImprovements: (value: unknown) => ipcRenderer.invoke("emma:set-improvements", value),
  forceArm: (value: { threadId: string; arm: "a" | "b" }) => ipcRenderer.invoke("emma:force-arm", value),
  listToolTargets: () => ipcRenderer.invoke("emma:list-tool-targets"),
  capabilityUsage: () => ipcRenderer.invoke("emma:capability-usage"),
  nextSteps: (value: unknown) => ipcRenderer.invoke("emma:next-steps", value),
  onToolsChanged: (listener: () => void) => {
    const wrapped = () => listener();
    ipcRenderer.on("emma:tools-changed", wrapped);
    return () => ipcRenderer.removeListener("emma:tools-changed", wrapped);
  },
  startCouncil: (value: CouncilStart) => ipcRenderer.invoke("emma:council-start", value) as Promise<CouncilState>,
  stopCouncil: (threadId: string) => ipcRenderer.invoke("emma:council-stop", { threadId }),
  adoptCouncil: (value: { threadId: string; seatId: string }) => ipcRenderer.invoke("emma:council-adopt", value) as Promise<CouncilState>,
  closeCouncil: (threadId: string) => ipcRenderer.invoke("emma:council-close", { threadId }),
  councilState: (threadId: string) => ipcRenderer.invoke("emma:council-state", { threadId }) as Promise<CouncilState | null>,
  onCouncil: (listener: (state: CouncilState) => void) => {
    const wrapped = (_event: unknown, value: unknown) => { if (value && typeof value === "object" && typeof (value as CouncilState).threadId === "string") listener(value as CouncilState); };
    ipcRenderer.on("emma:council", wrapped);
    return () => ipcRenderer.removeListener("emma:council", wrapped);
  },
  setThreadContext: (value: { threadId: string; folderIds: string[]; mode: string; model: string; effort?: string; subagentModel?: string; subagentEffort?: string; review?: boolean; stepLimit?: number }) => ipcRenderer.invoke("emma:set-thread-context", value),
  runCommand: (value: { command: string; folderId?: string }) => ipcRenderer.invoke("emma:run-command", value),
  listBackground: () => ipcRenderer.invoke("emma:list-background"),
  readBackground: (id: string) => ipcRenderer.invoke("emma:read-background", id),
  stopBackground: (id: string) => ipcRenderer.invoke("emma:stop-background", id),
  onBackground: (listener: () => void) => {
    const wrapped = () => listener();
    ipcRenderer.on("emma:background", wrapped);
    return () => ipcRenderer.removeListener("emma:background", wrapped);
  },
  listCliRuns: () => ipcRenderer.invoke("emma:list-cli-runs"),
  readCliRun: (id: string) => ipcRenderer.invoke("emma:read-cli-run", id),
  stopCliRun: (id: string) => ipcRenderer.invoke("emma:stop-cli-run", id),
  installedClis: () => ipcRenderer.invoke("emma:installed-clis"),
  semanticGrepStatus: () => ipcRenderer.invoke("emma:semantic-grep-status"),
  onSemanticGrep: (listener: () => void) => {
    const wrapped = () => listener();
    ipcRenderer.on("emma:semantic-grep", wrapped);
    return () => ipcRenderer.removeListener("emma:semantic-grep", wrapped);
  },
  zvecGrepStatus: () => ipcRenderer.invoke("emma:zvec-grep-status"),
  zvecGrepInstall: () => ipcRenderer.invoke("emma:zvec-grep-install"),
  zvecGrepCancel: () => ipcRenderer.invoke("emma:zvec-grep-cancel"),
  onZvecGrep: (listener: () => void) => {
    const wrapped = () => listener();
    ipcRenderer.on("emma:zvec-grep", wrapped);
    return () => ipcRenderer.removeListener("emma:zvec-grep", wrapped);
  },
  machineFacts: () => ipcRenderer.invoke("emma:machine-facts"),
  verifyEmbeddingKey: (id: string) => ipcRenderer.invoke("emma:verify-embedding-key", { id }),
  signInCli: (value: { signIn: string; columns: number; rows: number }) => ipcRenderer.invoke("emma:cli-sign-in", value),
  cliModels: (value: { cli: string; refresh?: boolean }) => ipcRenderer.invoke("emma:cli-models", value),
  setCliRunModel: (value: { id: string; model?: string; effort?: string }) => ipcRenderer.invoke("emma:cli-run-model", value),
  handoffCliRun: (value: import("../shared/cli").CliHandoffRequest) => ipcRenderer.invoke("emma:handoff-cli-run", value),
  sendCliRun: (value: { id: string; prompt: string }) => ipcRenderer.invoke("emma:send-cli-run", value),
  onCliRuns: (listener: () => void) => {
    const wrapped = () => listener();
    ipcRenderer.on("emma:cli-runs", wrapped);
    return () => ipcRenderer.removeListener("emma:cli-runs", wrapped);
  },
  browserStatus: (threadId: string) => ipcRenderer.invoke("emma:browser-status", threadId),
  browserOpen: (value: { threadId: string; url: string }) => ipcRenderer.invoke("emma:browser-open", value),
  browserNav: (value: { threadId: string; action: "back" | "forward" | "reload" | "close" }) => ipcRenderer.invoke("emma:browser-nav", value),
  browserPlace: (value: { threadId: string; bounds: { x: number; y: number; width: number; height: number } | null }) => ipcRenderer.invoke("emma:browser-place", value),
  browserClips: () => ipcRenderer.invoke("emma:browser-clips"),
  browserClipUse: (value: { threadId: string; index: number }) => ipcRenderer.invoke("emma:browser-clip-use", value),
  browserNewTab: (value: { threadId: string; url?: string }) => ipcRenderer.invoke("emma:browser-tab-new", value),
  browserSelectTab: (value: { threadId: string; tabId: string }) => ipcRenderer.invoke("emma:browser-tab-select", value),
  browserCloseTab: (value: { threadId: string; tabId: string }) => ipcRenderer.invoke("emma:browser-tab-close", value),
  onBrowser: (listener: () => void) => {
    const wrapped = () => listener();
    ipcRenderer.on("emma:browser", wrapped);
    return () => ipcRenderer.removeListener("emma:browser", wrapped);
  },
  onBrowserShow: (listener: (value: { threadId: string }) => void) => {
    const wrapped = (_event: unknown, value: unknown) => {
      const shown = value as { threadId?: unknown };
      if (typeof shown?.threadId === "string") listener({ threadId: shown.threadId });
    };
    ipcRenderer.on("emma:browser-show", wrapped);
    return () => ipcRenderer.removeListener("emma:browser-show", wrapped);
  },
  openTerminal: (value: { threadId: string; columns: number; rows: number; cli?: string }) => ipcRenderer.invoke("emma:terminal-open", value),
  writeTerminal: (value: { id: string; data: string }) => ipcRenderer.invoke("emma:terminal-write", value),
  resizeTerminal: (value: { id: string; columns: number; rows: number }) => ipcRenderer.invoke("emma:terminal-resize", value),
  closeTerminal: (id: string) => ipcRenderer.invoke("emma:terminal-close", id),
  listTerminals: (threadId: string) => ipcRenderer.invoke("emma:terminal-list", threadId),
  readTerminal: (id: string) => ipcRenderer.invoke("emma:terminal-buffer", id),
  onTerminalData: (listener: (value: { id: string; data: Uint8Array; at: number }) => void) => {
    const wrapped = (_event: unknown, value: unknown) => {
      const chunk = value as { id?: unknown; data?: unknown; at?: unknown };
      if (typeof chunk?.id === "string" && chunk.data instanceof Uint8Array && typeof chunk.at === "number") listener({ id: chunk.id, data: chunk.data, at: chunk.at });
    };
    ipcRenderer.on("emma:terminal-data", wrapped);
    return () => ipcRenderer.removeListener("emma:terminal-data", wrapped);
  },
  onTerminals: (listener: () => void) => {
    const wrapped = () => listener();
    ipcRenderer.on("emma:terminals", wrapped);
    return () => ipcRenderer.removeListener("emma:terminals", wrapped);
  },
  harnessReport: () => ipcRenderer.invoke("emma:harness-report"),
  restartHarness: () => ipcRenderer.invoke("emma:restart-harness"),
  onHarnessLog: (listener: (line: { at: number; flow: string; label: string; body: string }) => void) => {
    const wrapped = (_event: unknown, value: unknown) => {
      const line = value as { at?: unknown; flow?: unknown; label?: unknown; body?: unknown };
      if (typeof line?.at === "number" && typeof line.flow === "string" && typeof line.label === "string" && typeof line.body === "string") {
        listener({ at: line.at, flow: line.flow, label: line.label, body: line.body });
      }
    };
    ipcRenderer.on("emma:harness-log", wrapped);
    return () => ipcRenderer.removeListener("emma:harness-log", wrapped);
  },
  openLink: (url: string) => ipcRenderer.invoke("emma:open-link", url),
  listMemories: () => ipcRenderer.invoke("emma:list-memories"),
  deleteMemory: (path: string) => ipcRenderer.invoke("emma:delete-memory", path),
  listAgents: () => ipcRenderer.invoke("emma:list-agents"),
  listSpans: () => ipcRenderer.invoke("emma:list-spans"),
  livePartial: () => ipcRenderer.invoke("emma:live-partial"),
  listAsks: () => ipcRenderer.invoke("emma:list-asks"),
  threadTraces: (threadId: string) => ipcRenderer.invoke("emma:thread-traces", threadId),
  steerAgent: (value: { threadId: string; text: string }) => ipcRenderer.invoke("emma:steer-agent", value),
  stopAgent: (threadId?: string) => ipcRenderer.send("emma:stop-agent", threadId),
  answerPermission: (value: { id: string; allowed: boolean }) => ipcRenderer.send("emma:answer-permission", value),
  threadChanges: (threadId: string) => ipcRenderer.invoke("emma:thread-changes", threadId),
  revertChange: (value: { folderId: string; path: string; before: string }) => ipcRenderer.invoke("emma:revert-change", value),
  onAgents: (listener: (value: unknown[]) => void) => {
    const wrapped = (_event: unknown, value: unknown) => { if (Array.isArray(value)) listener(value); };
    ipcRenderer.on("emma:agents", wrapped);
    return () => ipcRenderer.removeListener("emma:agents", wrapped);
  },
  onSpans: (listener: (value: Record<string, unknown[]>) => void) => {
    const wrapped = (_event: unknown, value: unknown) => { if (value && typeof value === "object" && !Array.isArray(value)) listener(value as Record<string, unknown[]>); };
    ipcRenderer.on("emma:spans", wrapped);
    return () => ipcRenderer.removeListener("emma:spans", wrapped);
  },
  onPermissionAsk: (listener: (value: { id: string; threadId: string; tool: string; summary: string; detail: string }) => void) => {
    const wrapped = (_event: unknown, value: unknown) => { if (value && typeof value === "object") listener(value as { id: string; threadId: string; tool: string; summary: string; detail: string }); };
    ipcRenderer.on("emma:permission-ask", wrapped);
    return () => ipcRenderer.removeListener("emma:permission-ask", wrapped);
  },
  onPermissionResolved: (listener: (value: { id: string; allowed: boolean }) => void) => {
    const wrapped = (_event: unknown, value: unknown) => {
      const answer = value as { id?: unknown; allowed?: unknown };
      if (typeof answer?.id === "string" && typeof answer.allowed === "boolean") listener({ id: answer.id, allowed: answer.allowed });
    };
    ipcRenderer.on("emma:permission-resolved", wrapped);
    return () => ipcRenderer.removeListener("emma:permission-resolved", wrapped);
  },
  setZeroRetention: (value: boolean) => ipcRenderer.invoke("emma:set-zero-retention", value),
  listCredentials: () => ipcRenderer.invoke("emma:list-credentials"),
  openRouterBalance: () => ipcRenderer.invoke("emma:openrouter-balance"),
  deepseekBalance: () => ipcRenderer.invoke("emma:deepseek-balance"),
  saveCredential: (value: { env: string; secret?: string }) => ipcRenderer.invoke("emma:save-credential", value),
  fetchUrl: (url: string) => ipcRenderer.invoke("emma:fetch-url", url),
  clipPage: () => ipcRenderer.invoke("emma:clip-page"),
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
