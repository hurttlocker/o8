import type { OrchestratorBackendId } from '@/lib/lane/orchestrator-backends/types';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import type { OrchestratorExecutionMode } from '@/lib/orchestrator/types';
import type { OrchestratorPermissionMode } from './shared';

export function buildOrchestratorSendPayload(input: {
  repoPath: string;
  threadId: string;
  clientMessageId: string;
  wireMessage: string;
  displayMessage: string;
  permissionMode: OrchestratorPermissionMode;
  orchestrationMode: OrchestratorExecutionMode;
  thinkingEffort?: ThinkingEffort;
  model: string;
  backend?: OrchestratorBackendId;
  collideBaseBackend?: OrchestratorBackendId;
  attachments?: Array<{ dataUri: string; name?: string }>;
}): string {
  return JSON.stringify({
    type: 'orchestrator-send',
    repoPath: input.repoPath,
    threadId: input.threadId,
    clientMessageId: input.clientMessageId,
    message: input.wireMessage,
    displayMessage: input.displayMessage,
    permissionMode: input.permissionMode,
    orchestrationMode: input.orchestrationMode,
    ...(input.thinkingEffort && input.thinkingEffort !== 'adaptive'
      ? { thinkingEffort: input.thinkingEffort }
      : {}),
    model: input.model,
    ...(input.backend ? { backend: input.backend } : {}),
    ...(input.collideBaseBackend ? { collideBaseBackend: input.collideBaseBackend } : {}),
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
  });
}
