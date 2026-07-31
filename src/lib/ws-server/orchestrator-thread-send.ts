import type { OrchestratorBackendId } from '@/lib/lane/orchestrator-backends/types';
import type { MobileOrchestratorThread } from '@/lib/mobile/types';
import { appendMobileOrchestratorUserMessage } from '@/lib/mobile/orchestrator-thread-history';

export function persistOrchestratorThreadUserMessageFromWire(input: {
  message: Record<string, unknown>;
  tabId: string | null;
  repoPath: string;
  transcriptMessage: string;
  messageId: string;
  backend: OrchestratorBackendId;
  agent?: string;
  timestampMs: number;
}): MobileOrchestratorThread | null {
  return appendMobileOrchestratorUserMessage({
    tabId: input.tabId,
    repoPath: input.repoPath,
    projectId: input.message.projectId,
    message: input.transcriptMessage,
    messageId: input.messageId,
    backend: input.backend,
    agent: input.agent,
    timestampMs: input.timestampMs,
  });
}
