/**
 * Who pays for a review turn, and on what basis its cost is known (#3742).
 * Claude and Codex reviewers run on the operator's own subscriptions. A Pi
 * review runs on the operator's OpenRouter key when its model is an
 * `openrouter/<id>` choice, and on o8's managed allowance otherwise.
 */

import { getSqlite } from '@/lib/db';
import { logUsage } from '@/lib/db/usage';
import { isOpenRouterPiModelChoice } from '@/lib/pi/sdk/openrouter-model-choice';

export type ReviewPayer = 'anthropic-subscription' | 'openai-subscription' | 'openrouter' | 'o8-managed' | 'unknown';
/** `reported`: the provider returned the cost. `subscription`/`allowance`: no per-call charge to the operator. */
export type ReviewCostBasis = 'reported' | 'subscription' | 'allowance' | 'unknown';

export function reviewPayer(backend: string, model: string | null | undefined): { payer: ReviewPayer; costBasis: ReviewCostBasis } {
  if (backend === 'claude') return { payer: 'anthropic-subscription', costBasis: 'subscription' };
  if (backend === 'codex') return { payer: 'openai-subscription', costBasis: 'subscription' };
  if (backend === 'pi') {
    return isOpenRouterPiModelChoice(model)
      ? { payer: 'openrouter', costBasis: 'reported' }
      : { payer: 'o8-managed', costBasis: 'allowance' };
  }
  return { payer: 'unknown', costBasis: 'unknown' };
}

/**
 * One usage row per review turn. An OpenRouter review already writes a row per
 * model call, keyed by the same turn, so it writes none here.
 */
export function recordReviewTurnUsage(input: {
  laneId: string;
  packetId: string | null;
  repoPath: string;
  reviewTurnId: string;
  backend: string;
  model: string | null;
  surface: string;
  /** The cost the backend reported for the turn, if any; kept as notional for subscription turns. */
  reportedCostUsd: number | null;
}): void {
  const { payer, costBasis } = reviewPayer(input.backend, input.model);
  if (payer === 'openrouter') return;
  try {
    logUsage({
      userId: null,
      model: input.model ?? input.backend,
      provider: payer === 'anthropic-subscription' ? 'anthropic' : payer === 'openai-subscription' ? 'openai' : 'runtime',
      inputTokens: 0,
      outputTokens: 0,
      // A subscription or allowance turn costs the operator nothing per call; an unknown one is not guessed.
      costUsd: 0,
      sessionKey: `review:${input.reviewTurnId}`,
      repoPath: input.repoPath,
      laneId: input.laneId,
      packetId: input.packetId,
      role: 'reviewer',
      runId: input.reviewTurnId,
      agentName: `${input.backend}-reviewer`,
      requestType: 'chat',
      metadata: {
        payer, costSource: costBasis, backend: input.backend, surface: input.surface,
        notionalCostUsd: input.reportedCostUsd,
      },
    });
  } catch (error) {
    console.warn('[review-usage] usage row failed:', error instanceof Error ? error.message : error);
  }
}

export interface MissionReviewCost {
  packetId: string;
  reviewTurnId: string;
  model: string | null;
  payer: ReviewPayer;
  costBasis: ReviewCostBasis;
  calls: number;
  costUsd: number;
}

/** Review turns and their spend for the given packets, one entry per turn. */
export function listReviewCosts(packetIds: string[]): MissionReviewCost[] {
  if (packetIds.length === 0) return [];
  const rows = getSqlite().prepare(`
    SELECT packet_id, run_id, model, provider, cost_usd, metadata_json FROM usage_logs
    WHERE role = 'reviewer' AND run_id IS NOT NULL AND packet_id IN (${packetIds.map(() => '?').join(', ')})
    ORDER BY id ASC
  `).all(...packetIds) as Array<{ packet_id: string; run_id: string; model: string | null; provider: string;
    cost_usd: number | null; metadata_json: string | null }>;
  const turns = new Map<string, MissionReviewCost>();
  for (const row of rows) {
    const metadata = JSON.parse(row.metadata_json ?? '{}') as { payer?: ReviewPayer; costSource?: string };
    const payer = metadata.payer ?? (row.provider === 'openrouter' ? 'openrouter' : 'unknown');
    const turn = turns.get(row.run_id) ?? {
      packetId: row.packet_id, reviewTurnId: row.run_id, model: row.model, payer,
      costBasis: payer === 'openrouter' ? 'reported' : (metadata.costSource as ReviewCostBasis | undefined) ?? 'unknown',
      calls: 0, costUsd: 0,
    };
    if (payer === 'openrouter') {
      turn.calls += 1;
      if (metadata.costSource === 'unknown') turn.costBasis = 'unknown';
    }
    turn.costUsd = Math.round((turn.costUsd + (row.cost_usd ?? 0)) * 1e6) / 1e6;
    turns.set(row.run_id, turn);
  }
  return [...turns.values()];
}
