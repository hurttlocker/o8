import type { WorkerLaunchContext } from '@/lib/orchestrator/types';

export interface WatchedAgent {
  surfaceId: string;
  repoPath: string;
  name: string;
  prompt: string;
  launchContext?: WorkerLaunchContext;
  registeredAt: number;
  lastStatus: string;
  lastRuntimeStatus: string | null;
  lastTranscriptLength: number;
  lastTranscriptEntryId: string | null;
  lastTranscriptSignature: string | null;
  lastTranscriptMtimeMs: number | null;
  lastActivityAt: number;
  lastEventAt: number;
  retryCount: number;
  steerCount: number;
  completionReported: boolean;
  lastProgressEntryId: string | null;
  batchReported: boolean;
  tentativeFinishedSince: number | null;
  tentativeTranscriptLength: number;
  tentativeTranscriptEntryId: string | null;
  tentativeTranscriptSignature: string | null;
  pollOrdinal: number;
  nextPollAt: number;
  lastPolledAt: number | null;
}

export interface AgentStatusEntry {
  sessionKey: string;
  status: string;
  name?: string;
  workspace?: string;
  currentTask?: string;
}

export interface TranscriptEntry {
  id: string;
  role: string;
  text: string;
  timestamp?: number;
  timestampLabel?: string;
  toolName?: string;
}

export interface AgentUpdateEvent {
  surfaceId: string;
  name: string;
  status: string;
  detail?: string;
  duration?: number;
  repoPath?: string;
  launchContext?: WorkerLaunchContext;
}

export interface AgentCompletionDecision {
  block?: boolean;
  resume?: boolean;
  detail?: string;
}

export interface SupervisorCallbacks {
  fetchFleetStatus(): Promise<AgentStatusEntry[]>;
  fetchTranscript(sessionKey: string, limit: number): Promise<TranscriptEntry[]>;
  steerAgent(surfaceId: string, message: string): Promise<void>;
  interruptAgent(surfaceId: string): Promise<void>;
  relaunchAgent(prompt: string, repoPath: string, taskName: string, retryOfSurfaceId?: string): Promise<SupervisorRelaunchResult>;
  broadcastAgentUpdate(update: AgentUpdateEvent): void;
  queueOrchestratorEscalation(repoPath: string, message: string): void;
  onAgentProgress?: (surfaceId: string, lastMessage: string) => void;
  onAgentCompletion?: (
    surfaceId: string,
    outcome: 'completed' | 'failed',
  ) => Promise<AgentCompletionDecision | void> | AgentCompletionDecision | void;
  onAgentRetry?: (oldSurfaceId: string, newSurfaceId: string) => void;
}

export type SupervisorRelaunchResult =
  | { status: 'launched'; surfaceId: string }
  | { status: 'held'; reason: string };

export interface SupervisorFleetStatusSummary {
  repoPath: string;
  totalAgents: number;
  activeAgents: number;
  idleAgents: number;
  completedAgents: number;
  failedAgents: number;
  pendingAgents: number;
  allDone: boolean;
  allSucceeded: boolean;
  nextPollAt: number | null;
  lastUpdatedAt: number;
}
