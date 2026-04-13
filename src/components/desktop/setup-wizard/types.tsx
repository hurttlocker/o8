import type { ReactNode } from 'react';

export interface ToolDetection {
  detected: boolean;
  version?: string;
  error?: string;
  port?: number;
  agentCount?: number;
  responding?: boolean;
  activeThreads?: number;
  recentSessions?: number;
  hasDb?: boolean;
  memoryCount?: number;
  factCount?: number;
  models?: string[];
  hasEmbeddingModel?: boolean;
  /** opencode-specific: list of providers the user has authed via `opencode auth login` */
  authedProviders?: string[];
}

export interface ApiKeyStatus {
  provider: string;
  configured: boolean;
}

export interface DetectionResult {
  tools: {
    codex: ToolDetection;
    claudeCode: ToolDetection;
    gemini: ToolDetection;
    opencode: ToolDetection;
    cortex: ToolDetection;
    ollama: ToolDetection;
  };
  apiKeys: ApiKeyStatus[];
  hasAnything: boolean;
  hasAgentSurface: boolean;
  hasCliAgent: boolean;
  hasApiKey: boolean;
  hasMemory: boolean;
  hasEmbeddings: boolean;
  recommendedPath: string;
  summary: string;
}

export type WizardMode = 'ready' | 'quick-setup' | 'full-wizard';
export type FullWizardPath = 'agents' | 'chat' | 'explore';

export interface ToolDisplayInfo {
  id: string;
  name: string;
  detected: boolean;
  version?: string;
  detail?: string;
  icon: ReactNode;
}

export interface MissingToolAction {
  id: string;
  name: string;
  description: string;
  command?: string;
  link?: string;
  icon: ReactNode;
}
