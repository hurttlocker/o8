import type { ManualThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import type { OrchestratorBackendSetting, ThoughtsOperatorDefaults } from '../operator-defaults';

export const REPLY_MODEL_DEFAULTS = { backend: 'o8', model: 'o8-free', effort: 'low' } as const;

export interface ContextualConversation {
  requestContext: string;
  modelDefaults?: { backend: OrchestratorBackendSetting; model: string; effort: ManualThinkingEffort };
  initialDraft?: string;
  placeholder?: string;
  onDraftChange?: (draft: string) => void;
  onBusyChange?: (busy: boolean) => void;
}

/** Contextual defaults seed this conversation only; operator choices remain intact. */
export function contextualOperatorDefaults(defaults: ThoughtsOperatorDefaults, choice?: ContextualConversation['modelDefaults']): ThoughtsOperatorDefaults {
  return choice ? { ...defaults, orchestratorBackend: choice.backend, orchestratorModel: choice.model, thinkingEffort: choice.effort } : defaults;
}

/** Attach context to the provider turn while leaving the visible user text intact. */
export function contextualTurnMessage(message: string, context?: string): string {
  return context ? `${message}\n\n${context}` : message;
}
