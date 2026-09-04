import type { ScenarioResult } from './statistics.d.mts';

export interface BudgetSpec {
  statistic: 'p50' | 'p95' | 'p99';
  max: number;
  basis: string;
}

export interface InteractionBudgetManifest {
  status: string;
  lockedBy: string | null;
  metrics: Record<string, BudgetSpec>;
  noiseBandMs: Record<string, number>;
}

export interface BudgetResult {
  metric: string;
  statistic: string;
  scale: number | null;
  value: number | null;
  budgetMax: number;
  status: 'pass' | 'fail' | 'unavailable';
  reason: string | null;
  baselineValue: number | null;
  deltaValue: number | null;
  deltaStatus: 'improved' | 'regressed' | 'unchanged' | 'missing' | 'no-baseline';
}

export interface BudgetEvaluation {
  budgetStatus: string;
  buildMode: string | null;
  absoluteApplies: boolean;
  baselineSource: string | null;
  status: 'pass' | 'fail' | 'incomplete';
  failed: string[];
  regressed: string[];
  unavailable: Array<{ metric: string; reason: string }>;
  results: BudgetResult[];
}

export interface InteractionReceiptLike {
  schema?: string;
  target?: { buildMode?: string | null } | null;
  stack?: { buildMode?: string | null } | null;
  fixture?: { scale?: number | null } | null;
  scenarios?: Record<string, ScenarioResult | undefined>;
  soak?: { longTaskMsPerMinute?: number | null; unavailableReason?: string | null } | null;
  falsification?: {
    injectedDelayMs?: number;
    injectedDelayApplications?: number;
    delayExecuted?: boolean;
    metric?: string;
    budgetFailed?: boolean;
    skippedReason?: string;
  } | null;
  cleanup?: { status?: string; residue?: unknown } | null;
}

export const INTERACTION_BUDGETS: InteractionBudgetManifest;
export const BUDGET_ELIGIBLE_BUILD_MODES: readonly string[];

export function budgetsApply(buildMode: string | null | undefined): boolean;
export function metricObservations(receipt: InteractionReceiptLike): Array<{
  metric: string;
  scale: number | null;
  spec: BudgetSpec;
  value: number | null;
  note: string | null;
}>;
export function evaluateInteractionBudgets(
  receipt: InteractionReceiptLike,
  baseline?: { metrics?: Record<string, { value?: number | null }>; source?: string } | null,
  options?: { forceAbsolute?: boolean },
): BudgetEvaluation;
export function checkReceiptValidity(receipt: InteractionReceiptLike): string[];
