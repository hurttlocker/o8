import type { ImprovementExperiment, ImprovementUsage, ImprovementStageKind } from './types';

/** Report observations without turning nulls, subscription capacity or estimates into dollars. */
export function improvementAccounting(state: ImprovementExperiment) {
  const rows: Array<{ stage: ImprovementStageKind; usage: ImprovementUsage }> = state.records
    .map((row) => ({ stage: row.request.kind, usage: row.receipt.usage }));
  if (state.pendingReceipt && state.pending) rows.push({ stage: state.pending.kind, usage: state.pendingReceipt.usage });
  const unobservedReservations = state.pending && !state.pendingReceipt ? 1 : 0;
  const sum = (key: 'actualUsd' | 'estimatedUsd' | 'inputTokens' | 'outputTokens' | 'humanMs') => {
    let knownSubtotal = 0; let unknownRows = unobservedReservations;
    for (const row of rows) {
      const value = row.usage[key];
      if (value === null) unknownRows += 1; else knownSubtotal += value;
    }
    return { knownSubtotal, unknownRows, total: unknownRows ? null : knownSubtotal };
  };
  return {
    settledStageCount: state.records.length,
    reservedStageCount: state.pending ? 1 : 0,
    unobservedReservations,
    observedAttempts: rows.reduce((total, row) => total + row.usage.attempts, 0),
    actualUsd: sum('actualUsd'), estimatedUsd: sum('estimatedUsd'),
    inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), humanMs: sum('humanMs'),
    stageWallMs: rows.reduce((total, row) => total + row.usage.wallMs, 0),
    billingModes: [...new Set(rows.map((row) => row.usage.billing))],
    // Review/evaluation lives outside the improver. Until joined by its independent
    // ledger, source-stage completeness is not all-in experiment accounting.
    allInComplete: false as const,
    liveBenefitProven: false as const,
  };
}
