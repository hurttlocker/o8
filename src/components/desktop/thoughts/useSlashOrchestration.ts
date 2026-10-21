'use client';
import { useCallback } from 'react';
import type { SlashOrchestrationRequest } from '@/lib/slash-commands';
import type { OrchestratorSendOptions } from './use-orchestrator-stream/types';

/** One turn through the selected orchestrator; command text stays visible. */
export function useSlashOrchestration(send: (message: string, options: OrchestratorSendOptions) => unknown,
  options: OrchestratorSendOptions) {
  const { permissionMode, backend, thinkingEffort, model, orchestrationMode, collide, attachments } = options;
  return useCallback(async (request: SlashOrchestrationRequest) => {
    send(request.displayMessage, { permissionMode, backend, thinkingEffort, model, orchestrationMode, collide, attachments,
      wireMessage: request.prompt, displayMessage: request.displayMessage,
      localEntriesAfterUser: request.commandEntry ? [request.commandEntry] : [] });
  }, [send, permissionMode, backend, thinkingEffort, model, orchestrationMode, collide, attachments]);
}
