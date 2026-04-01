import type { RepoRegistryEntry } from '@/lib/repos/types';

export interface SetupWarmRuntimeAvailability {
  id: 'claude-code' | 'codex' | 'gemini';
  label: string;
  detected: boolean;
  version?: string;
}

export interface SetupWarmProfileContext {
  source?: string;
  importedTopicsCount?: number;
  labels?: string[];
  summary?: string;
}

export interface SetupWarmState {
  completedAt?: string;
  repoCount?: number;
  runtimeCount?: number;
  repos?: RepoRegistryEntry[];
  runtimes?: SetupWarmRuntimeAvailability[];
  profile?: SetupWarmProfileContext | null;
}

export interface SetupConfig {
  setupComplete: boolean;
  gateway?: {
    url: string;
    token: string;
    autoConnect: boolean;
  };
  cortex?: {
    binaryPath: string;
    detected: boolean;
  };
  completedAt?: string | null;
  skippedSteps?: string[];
  warmState?: SetupWarmState;
}
