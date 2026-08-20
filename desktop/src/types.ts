import type { ScreenPoint, ScreenStroke } from "../shared/screen-context";

export type ThreadRole = "user" | "assistant" | "system";

export interface Message {
  role: ThreadRole;
  content: string;
  timestamp: string;
  generation?: { outputTokens: number; durationMilliseconds: number } | null;
}

export interface Thread {
  id: string;
  title: string;
  knowledgeBaseId: string;
  sourceKnowledgeBaseIds: string[];
  createdAt: string;
  updatedAt: string;
  messages: Message[];
}

export interface KnowledgeBase {
  id: string;
  name: string;
  createdAt: string;
  categories: string[];
}

export interface ArtifactBlock {
  id: string;
  type: string;
  version: number;
  source: { sourceThreadId?: string; sourceUrl?: string };
  payload: unknown;
  fallback: string;
}

export interface KnowledgePage {
  id: string;
  knowledgeBaseId: string;
  title: string;
  category: string;
  context: { text: string; sourceApplication?: string; sourceUrl?: string };
  analysis: { summary: string; body: string };
  sources: { title: string; url: string }[];
  addedAt: string;
  analyzedAt: string;
  telemetry: { model: string; inputTokens: number; outputTokens: number; subagentCount: number };
  sourceThreadId?: string;
  artifacts?: ArtifactBlock[];
}

export interface ScheduledJob {
  id: string;
  title: string;
  schedule: string;
  prompt: string;
  sourceDomains: string[];
  enabled: boolean;
  createdAt: string;
  nextRunAt: string;
  lastRunAt?: string;
  lastThreadId?: string;
}

export interface Snapshot {
  threads: Thread[];
  knowledgeBases: KnowledgeBase[];
  pages: KnowledgePage[];
  scheduledJobs: ScheduledJob[];
  warnings: string[];
}

export interface OpenRouterCatalog {
  selectedModel?: string;
  models: { id: string; name: string; contextLength: number }[];
}

export interface AgentImportSource {
  id: string;
  label: string;
  mark: string;
  skills: number;
  mcpConfigs: number;
  locations: string[];
}

export interface ImportedSkill {
  id: string;
  source: string;
  name: string;
  threadId?: string;
}

export interface ImportedMcpServer {
  id: string;
  source: string;
  name: string;
  command: string;
  args: string[];
  argCount: number;
  environmentKeys: string[];
}

export interface ImportedMcpPermissionReview extends ImportedMcpServer {
  token: string;
  warning: string;
  capabilities: string[];
}

export interface ImportedMcpTool {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

export interface ImportedMcpCallResult {
  content?: unknown;
  isError?: boolean;
  [key: string]: unknown;
}

export interface UiPlugin {
  id: string;
  name: string;
  version: string;
  css: string;
}

export type { ScreenPoint, ScreenStroke };

declare global {
  interface Window {
    emma: {
      request<T>(method: string, params?: Record<string, string>): Promise<T>;
      setOverlayPreferences(value: unknown): void;
      setOverlayMousePassthrough(value: boolean): void;
      setOverlayBusy(value: boolean): void;
      startScreenAnnotation(): Promise<void>;
      getScreenAnnotationFrame(): Promise<{ image: string; width: number; height: number }>;
      finishScreenAnnotation(strokes: ScreenStroke[]): Promise<void>;
      cancelScreenAnnotation(): Promise<void>;
      screenAnnotationStatus(): Promise<{ id: string } | null>;
      clearScreenAnnotation(id: string): Promise<void>;
      discoverAgentImports(): Promise<AgentImportSource[]>;
      importAgentSources(ids: string[]): Promise<string[]>;
      searchImportedSkills(value: { query: string; limit?: number }): Promise<ImportedSkill[]>;
      selectImportedSkill(value: { id: string; threadId: string }): Promise<ImportedSkill>;
      importedSkillStatus(): Promise<(ImportedSkill & { threadId: string }) | null>;
      clearImportedSkill(id: string): Promise<void>;
      listImportedMcpServers(): Promise<ImportedMcpServer[]>;
      reviewImportedMcpServer(id: string): Promise<ImportedMcpPermissionReview>;
      connectImportedMcpServer(value: { serverId: string; token: string }): Promise<{ server: ImportedMcpServer; tools: number }>;
      searchMcpTools(value: { query: string; limit?: number }): Promise<ImportedMcpTool[]>;
      selectMcpTool(name: string): Promise<ImportedMcpTool>;
      callMcpTool(argsJson: string): Promise<ImportedMcpCallResult>;
      closeImportedMcpServer(): Promise<void>;
      loadUiPlugins(): Promise<UiPlugin[]>;
      onChanged(listener: () => void): number;
      offChanged(id: number): void;
    };
  }
}
