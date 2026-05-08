import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import type { OrchestratorMissionState } from '@/lib/orchestrator/types';

export type OrchestratorSlashCommandName =
  | 'ask'
  | 'orchestrate'
  | 'compact'
  | 'clear'
  | 'focus'
  | 'status'
  | 'recall'
  | 'handoff';

export interface OrchestratorSlashCommandDefinition {
  command: `/${string}`;
  name: OrchestratorSlashCommandName;
  title: string;
  description: string;
  argHint?: string;
  requiresArgument?: boolean;
  group?: 'route' | 'command' | 'context' | 'thread';
  aliases?: string[];
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

export interface SlashOrchestrationRequest {
  goal: string;
  rawCommand: string;
  displayMessage: string;
  prompt: string;
  commandEntry?: MobileTranscriptEntry;
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
  startOrchestration?: (request: SlashOrchestrationRequest) => Promise<void>;
  clearThread: () => Promise<void>;
}

export interface SlashCommandExecutionResult {
  handled: boolean;
}
