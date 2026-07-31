import type { OrchestratorBackendId } from '@/lib/lane/orchestrator-backends/types';
import type { ThoughtsHistoryMessage } from '../history-transcript';
import type { ThreadHistoryPage } from './useThreadHistoryBackfill';

export interface ThoughtsOrchestratorBusyState {
  active: boolean;
  startedAt: number | null;
  toolCallsStarted: number;
  toolCallsCompleted: number;
  latestToolLabel: string | null;
}

export interface ThoughtsSendNowOptions {
  attachments?: Array<{ dataUri: string; name: string }>;
}

export interface ThoughtsChatPanelHandle {
  focusInput: () => void;
  reset: () => void;
  loadThread: (tabId: string) => void;
  /**
   * Fire a send with optional pre-fill. If `text` is provided, replaces
   * the input first then sends. Used by Orchestrator quick-action cards
   * that click-to-dispatch.
   */
  sendNow: (text?: string, options?: ThoughtsSendNowOptions) => boolean;
  /**
   * Drop text into the composer at the current caret without sending.
   * Used by dictation: the user can review the polished transcript and
   * press send themselves. Appends a leading space if the existing
   * input doesn't already end with whitespace.
   */
  fillInput: (text: string) => void;
  copyAsMarkdown: () => Promise<boolean>;
}

export interface ThoughtsChatPanelChromeState {
  activeTargetLabel: string;
  waitingForReply: boolean;
  hasMessages: boolean;
  threadId: string | null;
  messageCount: number;
  orchestratorBusyState: ThoughtsOrchestratorBusyState | null;
}

export type ThoughtsChatPermissionMode = 'full' | 'plan';

export interface ThoughtsHistoryListResponse {
  conversations?: Array<{
    tabId: string;
    modifiedAt?: string;
    backend?: OrchestratorBackendId | null;
    agent?: string | null;
    projectId?: string | null;
  }>;
}

export interface ThoughtsHistoryResponse {
  messages?: ThoughtsHistoryMessage[];
  planText?: string | null;
  backend?: OrchestratorBackendId | null;
  agent?: string | null;
  projectId?: string | null;
  page?: ThreadHistoryPage<ThoughtsHistoryMessage>['page'];
}
