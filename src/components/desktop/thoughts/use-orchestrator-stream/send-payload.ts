import type { TaskArtifactActionStamp } from '@/lib/task-artifacts/types';
import type { OrchestratorBackendId } from '@/lib/lane/orchestrator-backends/types';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import type { OrchestratorExecutionMode } from '@/lib/orchestrator/types';
import type { OrchestratorPermissionMode } from './shared';

export function buildOrchestratorSendPayload(input: {
  repoPath: string;
  projectId?: string | null;
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
  handoffMode?: 'handoff';
  attachments?: Array<{ dataUri: string; name?: string }>;
  taskArtifactAction?: TaskArtifactActionStamp;
}): string {
  return JSON.stringify({
    type: 'orchestrator-send',
    repoPath: input.repoPath,
    ...(input.projectId ? { projectId: input.projectId } : {}),
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
    ...(input.handoffMode ? { handoffMode: input.handoffMode } : {}),
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    ...(input.taskArtifactAction ? { taskArtifactAction: input.taskArtifactAction } : {}),
  });
}
