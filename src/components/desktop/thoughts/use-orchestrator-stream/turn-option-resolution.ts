'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { OrchestratorExecutionMode } from '@/lib/orchestrator/types';
import type { OrchestratorBackendId } from '@/lib/lane/orchestrator-backends/types';
import {
  DEFAULT_ORCHESTRATOR_MODEL,
  type OrchestratorPermissionMode,
} from './shared';
import {
  resolveOrchestratorTurnOptions,
  TURN_OPTIONS_REFRESH_TIMEOUT,
} from './resolve-turn-options';
import type { OrchestratorSendOptions } from './types';

const TURN_OPTIONS_REFRESH_TIMEOUT_MS = 5_000;

export function prepareOrchestratorTurn(message: string, options?: OrchestratorSendOptions) {
  const permissionMode: OrchestratorPermissionMode = options?.permissionMode ?? 'full';
  const requestedOrchestrationMode = options?.orchestrationMode ?? 'fleet';
  const collide = options?.collide === true && requestedOrchestrationMode !== 'single';
  const backend: OrchestratorBackendId | undefined = collide ? 'collide' : options?.backend;
  const orchestrationMode: OrchestratorExecutionMode = collide ? 'fleet' : requestedOrchestrationMode;
  return {
    permissionMode,
    thinkingEffort: options?.thinkingEffort,
    model: options?.model?.trim() || DEFAULT_ORCHESTRATOR_MODEL,
    displayMessage: options?.displayMessage?.trim() || message,
    wireMessage: options?.wireMessage?.trim() || message,
    localEntriesAfterUser: options?.localEntriesAfterUser ?? [],
    collideBaseBackend: collide ? options?.backend : undefined,
    backend,
    orchestrationMode,
  };
}

export function useTurnOptionResolution(repoPath: string | null) {
  const controllersRef = useRef(new Map<string, AbortController>());
  const abort = useCallback((clientMessageId?: string) => {
    for (const [pendingId, controller] of controllersRef.current) {
      if (clientMessageId && pendingId !== clientMessageId) continue;
      controller.abort();
      controllersRef.current.delete(pendingId);
    }
  }, []);
  useEffect(() => {
    abort();
    return () => abort();
  }, [abort, repoPath]);
  const resolve = useCallback(async (clientMessageId: string, options?: OrchestratorSendOptions) => {
    const controller = new AbortController();
    controllersRef.current.set(clientMessageId, controller);
    const timeout = window.setTimeout(() => controller.abort(TURN_OPTIONS_REFRESH_TIMEOUT), TURN_OPTIONS_REFRESH_TIMEOUT_MS);
    try {
      return await resolveOrchestratorTurnOptions(options, controller.signal);
    } finally {
      window.clearTimeout(timeout);
      controllersRef.current.delete(clientMessageId);
    }
  }, []);
  return useMemo(() => ({ abort, resolve }), [abort, resolve]);
}
