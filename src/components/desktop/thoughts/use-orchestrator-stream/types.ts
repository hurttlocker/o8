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

export interface OrchestratorStreamOptions {
  projectId?: string | null;
  seededPlanText?: string | null;
  hasHistory?: boolean;
  threadId?: string | null;
  /**
   * Called when the hook synchronously mints a threadId inside `send()`
   * because the parent hasn't supplied one yet (first-message-on-empty-tab
   * path). The parent MUST update its own threadId state in response so the
   * next render keeps both sides aligned. Without this, ws-server's
   * `isThreadBacked` guard skips assistant-message persistence and the reply
   * silently drops on reload. See bug investigation 2026-05-27.
   */
  onThreadIdMint?: (threadId: string) => void;
  /** Requests a same-thread history refresh when server turn truth says a
   * settled assistant message is missing from the visible transcript. */
  onSettledAssistantMissing?: (assistantMessageId: string) => void;
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
