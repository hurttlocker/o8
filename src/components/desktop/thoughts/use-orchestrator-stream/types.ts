import type { OrchestratorBackendId } from '@/lib/lane/orchestrator-backends/types';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import type { OrchestratorExecutionMode } from '@/lib/orchestrator/types';
import type { ThoughtsOrchestratorBusyState } from '@/components/desktop/thoughts/chat-panel/types';
import type { OrchestratorPermissionMode, OrchestratorStreamStatus } from './shared';

export interface OrchestratorSendHandle {
  clientMessageId: string;
  userMessageId: string;
  threadId: string;
  backend: OrchestratorBackendId | null;
  transcriptBeforeSend: MobileTranscriptEntry[];
}

export interface OrchestratorSendOptions {
  permissionMode?: OrchestratorPermissionMode;
  backend?: OrchestratorBackendId;
  thinkingEffort?: ThinkingEffort;
  model?: string;
  /** Model-facing text. The positional message remains operator-authored text. */
  wireMessage?: string;
  displayMessage?: string;
  localEntriesAfterUser?: MobileTranscriptEntry[];
  orchestrationMode?: OrchestratorExecutionMode;
  collide?: boolean;
  attachments?: Array<{ dataUri: string; name?: string }>;
}

export interface OrchestratorStreamResult {
  messages: MobileTranscriptEntry[];
  planText: string | null;
  status: OrchestratorStreamStatus;
  busyState: ThoughtsOrchestratorBusyState;
  tokenCount: number;
  runningTotal: number;
  estimateNextTurnTokens: (message: string) => number;
  send: (message: string, options?: OrchestratorSendOptions) => OrchestratorSendHandle | null;
  interrupt: () => void;
  undoSend: (handle: OrchestratorSendHandle) => void;
  appendLocalEntries: (entries: MobileTranscriptEntry[]) => void;
  replaceTranscript: (entries: MobileTranscriptEntry[]) => void;
  fetchTelemetrySnapshot: () => Promise<{
    totalTokens: number | null;
    estimatedCostUsd: number | null;
    model: string | null;
  }>;
  compactNow: (options?: { keepTailCount?: number; source?: 'manual' | 'handoff' }) => Promise<{
    applied: boolean;
    transcript: MobileTranscriptEntry[];
    resumePrelude: string | null;
    tokensAfter: number;
  } | null>;
  reset: () => void;
  retryPendingSend: (clientMessageId: string) => void;
  connected: boolean;
}
