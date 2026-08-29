import { recordLaneEvent } from '@/lib/lane/events';
import {
  buildCrossHouseFallbackMessage,
  isRuntimeQuotaLimitError,
  resolveCrossHouseFallback,
  type CrossHouseFallbackDecision,
} from '@/lib/orchestrator/cross-house-policy';
import { getOperatorDefaultsSync } from '@/lib/operator/defaults';
import { createBackendRoleRouteChoice } from '@/lib/operator/role-routing';
import { recordRoleRoutingReceiptSafely } from '@/lib/operator/role-routing-ledger';
import { MODEL_IDS } from '@/lib/models';
import {
  bindReviewTurnAbortController,
  finishReviewTurn,
  startReviewTurn,
} from '@/lib/lane/review-turn-state';
import type { OrchestratorEvent } from './orchestrator-stream-events';
import {
  getActiveReviewerBackend,
  getOrchestratorBackend,
} from './orchestrator-backends/registry';
import type { OrchestratorBackend, OrchestratorBackendId } from './orchestrator-backends/types';
import {
  isReviewerSessionBusyMessage,
  type ReviewUnavailableReason,
} from './review-transient-failure';

export interface ReviewFallbackTurnResult {
  ok: boolean;
  backend: OrchestratorBackendId;
  text: string;
  errors: string[];
  fallback: CrossHouseFallbackDecision | null;
  reviewTurnId: string | null;
  unavailableReason: ReviewUnavailableReason | null;
  approximateCost: number | null;
}

interface ReviewAttemptResult {
  text: string;
  errors: string[];
  quotaError: string | null;
  reviewTurnId: string | null;
  unavailableReason: ReviewUnavailableReason | null;
  approximateCost: number | null;
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
  expectedHeadSha?: string | null;
  model?: string;
  signal?: AbortSignal;
  onEvent?: (backend: OrchestratorBackend, event: OrchestratorEvent) => void;
}): Promise<ReviewAttemptResult> {
  const session = input.backend.ensureSession(input.repoPath, undefined, input.threadId);
  if (session.status === 'busy') {
    return {
      text: '',
      errors: [`${input.backend.label} session ${session.status}`],
      quotaError: null,
      reviewTurnId: null,
      unavailableReason: 'session_busy',
      approximateCost: null,
    };
  }

  const reviewTurnId = startReviewTurn({
    laneId: input.laneId,
    threadId: input.threadId,
    backend: input.backend.id,
    surface: input.surface,
    expectedHeadSha: input.expectedHeadSha,
  });
  const turnController = new AbortController();
  const forwardAbort = () => turnController.abort(input.signal?.reason);
  if (input.signal?.aborted) forwardAbort();
  else input.signal?.addEventListener('abort', forwardAbort, { once: true });
  const unbindAbortController = bindReviewTurnAbortController(
    input.laneId,
    reviewTurnId,
    turnController,
  );
  let text = '';
  let quotaError: string | null = null;
  let unavailableReason: ReviewUnavailableReason | null = null;
  let approximateCost: number | null = null;
  const errors: string[] = [];
  try {
    await input.backend.sendTurn(input.repoPath, input.prompt, (event) => {
      if (event.type === 'text') text += event.text;
      if (event.type === 'done' && typeof event.cost === 'number') approximateCost = event.cost;
      if (event.type === 'error') {
        if (isRuntimeQuotaLimitError(event)) quotaError = event.error;
        else errors.push(event.error);
      }
      input.onEvent?.(input.backend, event);
    }, {
      threadId: input.threadId,
      ...(input.model ? { model: input.model } : {}),
      signal: turnController.signal,
    });
  } catch (error) {
    if (isRuntimeQuotaLimitError(error)) quotaError = message(error);
    else {
      const errorMessage = message(error);
      if (isReviewerSessionBusyMessage(errorMessage)) unavailableReason = 'session_busy';
      errors.push(errorMessage);
    }
  } finally {
    unbindAbortController();
    input.signal?.removeEventListener('abort', forwardAbort);
  }
  // Claude Code can emit a terminal subscription denial as ordinary assistant
  // text and then exit successfully. Treat that observed frame as exhaustion so
  // the review crosses houses once instead of re-queueing the same dead backend.
  if (!quotaError && errors.length === 0 && isRuntimeQuotaLimitError(text)) {
    quotaError = text;
    text = '';
  }
  const outcome = turnController.signal.aborted
    ? 'failed'
    : quotaError
      ? 'quota_discarded'
      : errors.length > 0 ? 'failed' : 'completed';
  try {
    finishReviewTurn({ laneId: input.laneId, reviewTurnId, outcome });
  } catch (error) {
    errors.push(`Review turn finalization failed: ${message(error)}`);
  }
  return { text, errors, quotaError, reviewTurnId, unavailableReason, approximateCost };
}

export async function runReviewerTurnWithQuotaFallback(input: {
  laneId: string;
  repoPath: string;
  threadId: string;
  surface: 'auto-review' | 'merge-gate-review' | 'packet-explainer' | 'buyin-doc';
  prompt: string | ((backend: OrchestratorBackendId) => string);
  /** HEAD this turn's prompt and diff describe. */
  expectedHeadSha?: string | null;
  onEvent?: (backend: OrchestratorBackend, event: OrchestratorEvent) => void;
  initialBackend?: OrchestratorBackend;
  backendResolver?: (backend: OrchestratorBackendId) => OrchestratorBackend;
  signal?: AbortSignal;
}): Promise<ReviewFallbackTurnResult> {
  const initialBackend = input.initialBackend ?? getActiveReviewerBackend();
  const backendResolver = input.backendResolver ?? getOrchestratorBackend;
  const defaults = getOperatorDefaultsSync();
  const modelForBackend = (backend: OrchestratorBackendId, override?: string | null) => {
    if (override) return override;
    if (backend === 'claude') return defaults.values.orchestratorModel;
    if (backend === 'codex') return MODEL_IDS.codexDefault;
    if (backend === 'opencode') return defaults.values.opencodeOrchestratorModel;
    return null;
  };
  const requestedRoute = createBackendRoleRouteChoice(
    initialBackend.id,
    modelForBackend(initialBackend.id),
    defaults.values.thinkingEffort,
  );
  const finalize = (result: ReviewFallbackTurnResult): ReviewFallbackTurnResult => {
    const fallbackReason = result.fallback ? buildCrossHouseFallbackMessage(result.fallback) : null;
    const effectiveModel = result.fallback?.action === 'handoff'
      ? modelForBackend(result.backend, result.fallback.toModel)
      : modelForBackend(result.backend);
    recordRoleRoutingReceiptSafely({
      receiptKey: `review:${result.reviewTurnId ?? input.threadId}`,
      role: 'review',
      repoPath: input.repoPath,
      contextType: input.surface,
      contextId: input.laneId,
      requested: requestedRoute,
      effective: createBackendRoleRouteChoice(
        result.backend,
        effectiveModel,
        defaults.values.thinkingEffort,
      ),
      sources: {
        backend: defaults.sources.reviewerBackend,
        runtime: defaults.values.reviewerBackend === 'follow' ? 'derived' : defaults.sources.reviewerBackend,
        model: effectiveModel ? 'derived' : 'runtime-default',
        effort: defaults.sources.thinkingEffort,
      },
      reason: result.ok
        ? `${input.surface} completed on ${result.backend}.`
        : `${input.surface} did not complete on ${result.backend}: ${result.errors.join('; ') || result.unavailableReason || 'unknown failure'}`,
      fallbackReason,
      status: result.ok
        ? result.fallback ? 'fallback' : 'selected'
        : result.unavailableReason ? 'refused' : 'failed',
    });
    return result;
  };
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
    expectedHeadSha: input.expectedHeadSha,
    onEvent: input.onEvent,
    signal: input.signal,
  });
  if (first.unavailableReason) {
    return finalize({
      ok: false,
      backend: initialBackend.id,
      text: '',
      errors: first.errors,
      fallback: null,
      reviewTurnId: first.reviewTurnId,
      unavailableReason: first.unavailableReason,
      approximateCost: first.approximateCost,
    });
  }
  if (!first.quotaError) {
    return finalize({
      ok: first.errors.length === 0,
      backend: initialBackend.id,
      text: first.text,
      errors: first.errors,
      fallback: null,
      reviewTurnId: first.reviewTurnId,
      unavailableReason: null,
      approximateCost: first.approximateCost,
    });
  }

  const decision = resolveCrossHouseFallback({
    role: 'review',
    backend: initialBackend.id,
    subscriptionProfile: getOperatorDefaultsSync().values.subscriptionProfile,
  });
  if (!decision) {
    return finalize({
      ok: false,
      backend: initialBackend.id,
      text: '',
      errors: [first.quotaError],
      fallback: null,
      reviewTurnId: first.reviewTurnId,
      unavailableReason: null,
      approximateCost: first.approximateCost,
    });
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
    return finalize({
      ok: false,
      backend: initialBackend.id,
      text: '',
      errors: [first.quotaError],
      fallback: decision,
      reviewTurnId: first.reviewTurnId,
      unavailableReason: null,
      approximateCost: first.approximateCost,
    });
  }

  const fallbackBackend = backendResolver(decision.toBackend);
  const second = await runAttempt({
    backend: fallbackBackend,
    laneId: input.laneId,
    surface: input.surface,
    repoPath: input.repoPath,
    threadId: input.threadId,
    prompt: promptFor(fallbackBackend.id),
    expectedHeadSha: input.expectedHeadSha,
    model: decision.toModel,
    onEvent: input.onEvent,
    signal: input.signal,
  });
  if (second.unavailableReason) {
    return finalize({
      ok: false,
      backend: fallbackBackend.id,
      text: '',
      errors: second.errors,
      fallback: decision,
      reviewTurnId: second.reviewTurnId,
      unavailableReason: second.unavailableReason,
      approximateCost: second.approximateCost ?? first.approximateCost,
    });
  }
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
  return finalize({
    ok: errors.length === 0,
    backend: fallbackBackend.id,
    text: errors.length === 0 ? second.text : '',
    errors,
    fallback: decision,
    reviewTurnId: second.reviewTurnId,
    unavailableReason: null,
    approximateCost: second.approximateCost ?? first.approximateCost,
  });
}
