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
  | 'handoff'
  | 'rule'
  | 'rules'
  | 'prompts';

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
  /** Add a session rule to the active thread (POST + refresh). Returns false
   *  when there's no thread yet or the add is rejected. `/rule` uses this. */
  addSessionRule?: (text: string) => Promise<boolean>;
  /** Open the session-rules manager popover. `/rules` uses this — the add-path
   *  when the composer chip is hidden because no rules exist yet. */
  openRulesManager?: () => void;
  /** Open the saved-prompt picker over the active composer. */
  openPromptLibrary?: () => void;
}

export interface SlashCommandExecutionResult {
  handled: boolean;
}
