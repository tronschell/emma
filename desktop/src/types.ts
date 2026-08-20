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

export interface UiPlugin {
  id: string;
  name: string;
  version: string;
  css: string;
}

declare global {
  interface Window {
    emma: {
      request<T>(method: string, params?: Record<string, string>): Promise<T>;
      setOverlayPreferences(value: unknown): void;
      setOverlayMousePassthrough(value: boolean): void;
      setOverlayBusy(value: boolean): void;
      startScreenAnnotation(): Promise<void>;
      getScreenAnnotationFrame(): Promise<{ image: string; width: number; height: number }>;
      finishScreenAnnotation(value: string): Promise<void>;
      cancelScreenAnnotation(): Promise<void>;
      screenAnnotationStatus(): Promise<{ id: string } | null>;
      clearScreenAnnotation(id: string): Promise<void>;
      discoverAgentImports(): Promise<AgentImportSource[]>;
      importAgentSources(ids: string[]): Promise<string[]>;
      loadUiPlugins(): Promise<UiPlugin[]>;
      onChanged(listener: () => void): number;
      offChanged(id: number): void;
    };
  }
}
