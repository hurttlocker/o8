import type { OrchestratorBackendId } from '@/lib/lane/orchestrator-backends/types';
import type { MobileOrchestratorThread, MobileTranscriptEntry } from '@/lib/mobile/types';
import { appendMobileOrchestratorUserMessage } from '@/lib/mobile/orchestrator-thread-history';
import { persistComposerImages, type ComposerImageAttachment } from '@/lib/mobile/orchestrator-image-media';

export function persistOrchestratorThreadUserMessageFromWire(input: {
  message: Record<string, unknown>;
  tabId: string | null;
  repoPath: string;
  transcriptMessage: string;
  messageId: string;
  backend: OrchestratorBackendId;
  agent?: string;
  timestampMs: number;
  attachments?: ComposerImageAttachment[];
  handoff?: MobileTranscriptEntry['handoff'];
}): MobileOrchestratorThread | null {
  const media = persistComposerImages(input.attachments ?? []);
  return appendMobileOrchestratorUserMessage({
    tabId: input.tabId,
    repoPath: input.repoPath,
    projectId: input.message.projectId,
    message: input.transcriptMessage,
    messageId: input.messageId,
    backend: input.backend,
    agent: input.agent,
    timestampMs: input.timestampMs,
    media,
    handoff: input.handoff,
  });
}
