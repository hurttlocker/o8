import { recordLaneEvent } from '@/lib/lane/events';
import {
  buildCrossHouseFallbackMessage,
  isRuntimeQuotaLimitError,
  resolveCrossHouseFallback,
  type CrossHouseFallbackDecision,
} from '@/lib/orchestrator/cross-house-policy';
import { getOperatorDefaultsSync } from '@/lib/operator/defaults';
import { finishReviewTurn, startReviewTurn } from '@/lib/lane/review-turn-state';
import type { OrchestratorEvent } from './orchestrator-stream-events';
import {
  getActiveReviewerBackend,
  getOrchestratorBackend,
} from './orchestrator-backends/registry';
import type { OrchestratorBackend, OrchestratorBackendId } from './orchestrator-backends/types';

export interface ReviewFallbackTurnResult {
  ok: boolean;
  backend: OrchestratorBackendId;
  text: string;
  errors: string[];
  fallback: CrossHouseFallbackDecision | null;
  reviewTurnId: string | null;
}

interface ReviewAttemptResult {
  text: string;
  errors: string[];
  quotaError: string | null;
  reviewTurnId: string | null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runAttempt(input: {
  backend: OrchestratorBackend;
  repoPath: string;
  threadId: string;
  laneId: string;
  surface: string;
  prompt: string;
  model?: string;
  onEvent?: (backend: OrchestratorBackend, event: OrchestratorEvent) => void;
}): Promise<ReviewAttemptResult> {
  const session = input.backend.ensureSession(input.repoPath, undefined, input.threadId);
  if (session.status === 'busy' || session.status === 'dead') {
    return {
      text: '',
      errors: [`${input.backend.label} session ${session.status}`],
      quotaError: null,
      reviewTurnId: null,
    };
  }

  const reviewTurnId = startReviewTurn({
    laneId: input.laneId,
    threadId: input.threadId,
    backend: input.backend.id,
    surface: input.surface,
  });
  let text = '';
  let quotaError: string | null = null;
  const errors: string[] = [];
  try {
    await input.backend.sendTurn(input.repoPath, input.prompt, (event) => {
      if (event.type === 'text') text += event.text;
      if (event.type === 'error') {
        if (isRuntimeQuotaLimitError(event)) quotaError = event.error;
        else errors.push(event.error);
      }
      input.onEvent?.(input.backend, event);
    }, {
      threadId: input.threadId,
      ...(input.model ? { model: input.model } : {}),
    });
  } catch (error) {
    if (isRuntimeQuotaLimitError(error)) quotaError = message(error);
    else errors.push(message(error));
  }
  // Claude Code can emit a terminal subscription denial as ordinary assistant
  // text and then exit successfully. Treat that observed frame as exhaustion so
  // the review crosses houses once instead of re-queueing the same dead backend.
  if (!quotaError && errors.length === 0 && isRuntimeQuotaLimitError(text)) {
    quotaError = text;
    text = '';
  }
  const outcome = quotaError ? 'quota_discarded' : errors.length > 0 ? 'failed' : 'completed';
  try {
    finishReviewTurn({ laneId: input.laneId, reviewTurnId, outcome });
  } catch (error) {
    errors.push(`Review turn finalization failed: ${message(error)}`);
  }
  return { text, errors, quotaError, reviewTurnId };
}

export async function runReviewerTurnWithQuotaFallback(input: {
  laneId: string;
  repoPath: string;
  threadId: string;
  surface: 'auto-review' | 'merge-gate-review' | 'packet-explainer' | 'buyin-doc';
  prompt: string | ((backend: OrchestratorBackendId) => string);
  onEvent?: (backend: OrchestratorBackend, event: OrchestratorEvent) => void;
  initialBackend?: OrchestratorBackend;
  backendResolver?: (backend: OrchestratorBackendId) => OrchestratorBackend;
}): Promise<ReviewFallbackTurnResult> {
  const initialBackend = input.initialBackend ?? getActiveReviewerBackend();
  const backendResolver = input.backendResolver ?? getOrchestratorBackend;
  const promptFor = (backend: OrchestratorBackendId) => (
    typeof input.prompt === 'function' ? input.prompt(backend) : input.prompt
  );
  const first = await runAttempt({
    backend: initialBackend,
    laneId: input.laneId,
    surface: input.surface,
    repoPath: input.repoPath,
    threadId: input.threadId,
    prompt: promptFor(initialBackend.id),
    onEvent: input.onEvent,
  });
  if (!first.quotaError) {
    return {
      ok: first.errors.length === 0,
      backend: initialBackend.id,
      text: first.text,
      errors: first.errors,
      fallback: null,
      reviewTurnId: first.reviewTurnId,
    };
  }

  const decision = resolveCrossHouseFallback({
    role: 'review',
    backend: initialBackend.id,
    subscriptionProfile: getOperatorDefaultsSync().values.subscriptionProfile,
  });
  if (!decision) {
    return {
      ok: false,
      backend: initialBackend.id,
      text: '',
      errors: [first.quotaError],
      fallback: null,
      reviewTurnId: first.reviewTurnId,
    };
  }

  recordLaneEvent(input.laneId, 'review_fallback', 'system', {
    surface: input.surface,
    status: decision.action === 'hold' ? 'held' : 'retrying',
    fromBackend: decision.fromBackend,
    toBackend: decision.toBackend,
    fromHouse: decision.fromHouse,
    toHouse: decision.toHouse,
    fromModel: decision.fromModel,
    toModel: decision.toModel,
    runtimeTier: decision.runtimeTier,
    note: buildCrossHouseFallbackMessage(decision),
  });
  if (decision.action === 'hold') {
    return {
      ok: false,
      backend: initialBackend.id,
      text: '',
      errors: [first.quotaError],
      fallback: decision,
      reviewTurnId: first.reviewTurnId,
    };
  }

  const fallbackBackend = backendResolver(decision.toBackend);
  const second = await runAttempt({
    backend: fallbackBackend,
    laneId: input.laneId,
    surface: input.surface,
    repoPath: input.repoPath,
    threadId: input.threadId,
    prompt: promptFor(fallbackBackend.id),
    model: decision.toModel,
    onEvent: input.onEvent,
  });
  if (second.quotaError) {
    recordLaneEvent(input.laneId, 'review_fallback', 'system', {
      surface: input.surface,
      status: 'fallback_exhausted',
      fromBackend: initialBackend.id,
      toBackend: fallbackBackend.id,
      note: `${decision.toHouse} subscription also exhausted; review remains incomplete and merge stays blocked.`,
    });
  }
  const errors = second.quotaError ? [second.quotaError, ...second.errors] : second.errors;
  return {
    ok: errors.length === 0,
    backend: fallbackBackend.id,
    text: errors.length === 0 ? second.text : '',
    errors,
    fallback: decision,
    reviewTurnId: second.reviewTurnId,
  };
}
