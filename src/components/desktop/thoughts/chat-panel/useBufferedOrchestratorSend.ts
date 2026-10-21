'use client';

import { useCallback } from 'react';
import { track } from '@/lib/analytics/track';
import { isOrchestratorBackendId } from '@/lib/lane/orchestrator-backends/types';
import type { ComposerQueuePayload } from '@/lib/orchestrator/composer-queue-types';
import type { ComposerSendImage } from '@/lib/hooks/use-composer-send-buffer';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import { composeComposerTurnMessage, type ComposerMode } from '../composer-mode';
import { readComposerServiceTier } from '../composer-selector/service-tier-store';
import { resolveBackendTurnModel } from '@/lib/orchestrator/turn-model-selection';
import { composerBackendTurnOverride } from '../useBackendSwitchChoice';
import type { OrchestratorBackendSetting } from '../operator-defaults';
import type { OrchestratorSendHandle, OrchestratorSendOptions } from '../use-orchestrator-stream/types';
import { contextualTurnMessage, type ContextualConversation } from './contextual-turn';

export function useBufferedOrchestratorSend(input: {
  active: boolean; backend: OrchestratorBackendSetting; model: string; effort: ThinkingEffort;
  permissionMode: 'full' | 'plan'; mode: ComposerMode; solo: boolean; collide: boolean;
  projectId: string | null; context?: ContextualConversation['requestContext'];
  send: (message: string, options: OrchestratorSendOptions) => OrchestratorSendHandle | null;
}) {
  const dispatch = useCallback((text: string, images: ComposerSendImage[]) => {
    if (!input.active) return null;
    const turn = composeComposerTurnMessage(text, input.mode, input.solo);
    track('orchestrator.message');
    return input.send(turn.displayMessage, { permissionMode: input.permissionMode,
      backend: composerBackendTurnOverride(input.backend), thinkingEffort: input.effort,
      model: input.model, wireMessage: turn.wireMessage, displayMessage: turn.displayMessage,
      orchestrationMode: turn.orchestrationMode, collide: input.collide,
      ...(images.length ? { attachments: images } : {}) });
  }, [input]);
  const capture = useCallback((text: string, images: ComposerSendImage[]): ComposerQueuePayload => {
    if (!isOrchestratorBackendId(input.backend) || !input.model.trim()) throw new Error('Wait for the selected runtime and model before using Send next.');
    const turn = composeComposerTurnMessage(text, input.mode, input.solo);
    const effectiveBackend = input.collide && turn.orchestrationMode !== 'single' ? 'collide' : input.backend;
    const effectiveModel = resolveBackendTurnModel(effectiveBackend, input.model) ?? input.model;
    const serviceTier = effectiveBackend === 'codex' || effectiveBackend === 'claude' ? readComposerServiceTier(effectiveBackend, effectiveModel) : undefined;
    return { text: turn.displayMessage, wireMessage: contextualTurnMessage(turn.wireMessage, input.context),
      images: images.map(image => ({ ...image })), routing: { backend: input.backend, model: input.model,
        effort: input.effort, permissionMode: input.permissionMode, mode: turn.orchestrationMode,
        pickedMode: input.mode, collide: input.collide, ...(serviceTier ? { serviceTier } : {}), ...(input.projectId ? { projectId: input.projectId } : {}) } };
  }, [input]);
  return { dispatch, capture };
}
