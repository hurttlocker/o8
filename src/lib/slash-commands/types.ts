import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import type { OrchestratorMissionState } from '@/lib/orchestrator/types';

export type OrchestratorSlashCommandName =
  | 'compact'
  | 'clear'
  | 'focus'
  | 'status'
  | 'recall'
  | 'handoff';

export interface OrchestratorSlashCommandDefinition {
  command: `/${OrchestratorSlashCommandName}`;
  name: OrchestratorSlashCommandName;
  title: string;
  description: string;
  argHint?: string;
  requiresArgument?: boolean;
}

export interface ParsedOrchestratorSlashCommand {
  raw: string;
  command: OrchestratorSlashCommandDefinition;
  args: string;
}

export interface OrchestratorArchiveMatch {
  id: string;
  score: number;
  source: 'thread' | 'compaction';
  tabId: string | null;
  archivedAt: string | null;
  preview: string;
  entries: MobileTranscriptEntry[];
}

export interface SlashCommandStripChip {
  label: string;
  tone?: 'blue' | 'amber' | 'emerald' | 'slate' | 'red';
}

export interface SlashCommandContext {
  repoPath: string | null;
  transcript: MobileTranscriptEntry[];
  missionState: OrchestratorMissionState;
  runningTotal: number;
  currentModel: string;
  setCurrentModel: (model: string) => void;
  appendEntries: (entries: MobileTranscriptEntry[]) => void;
  replaceTranscript: (entries: MobileTranscriptEntry[]) => void;
  compactNow: (options?: { keepTailCount?: number; source?: 'manual' | 'handoff' }) => Promise<{
    applied: boolean;
    transcript: MobileTranscriptEntry[];
    resumePrelude: string | null;
    tokensAfter: number;
  } | null>;
  resetRemoteSession: () => Promise<boolean>;
  queuePrelude: (prelude: string, mode?: 'append' | 'replace') => void;
  searchArchive: (query: string, limit?: number) => Promise<OrchestratorArchiveMatch[]>;
  fetchTelemetry: () => Promise<{
    totalTokens: number | null;
    estimatedCostUsd: number | null;
    model: string | null;
  }>;
  clearThread: () => Promise<void>;
}

export interface SlashCommandExecutionResult {
  handled: boolean;
}
