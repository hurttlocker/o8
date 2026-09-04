import type { BudgetEvaluation } from './interactions/budgets.d.mts';

export interface InteractionRun {
  scale: number;
  budgets?: BudgetEvaluation;
  validity?: string[];
}

export function baselineFromReceipt(receipt: {
  version?: string | null;
  gitSha?: string | null;
  host?: unknown;
  samples?: number | null;
  runStatus?: string;
  targetLane?: { kind?: string; appPath?: string | null };
  runs?: Array<{
    scale: number;
    target?: unknown;
    stack?: { buildMode?: string | null; releaseArtifact?: unknown };
    fixture?: { scale?: number | null; digest?: string | null };
    budgets?: BudgetEvaluation;
    cleanup?: { status?: string };
    falsification?: {
      injectedDelayMs?: number;
      injectedDelayApplications?: number;
      delayExecuted?: boolean;
      budgetFailed?: boolean;
    };
  }>;
}): {
  schema: 'o8/interaction-baseline/v1';
  status: 'observed';
  observedAt: string;
  observedFrom: Record<string, unknown>;
  metrics: Record<string, { value: number; statistic: string; scale: number | null }>;
};

export function deriveRunStatus(runs: InteractionRun[], extraValidity?: string[]): {
  runStatus: 'pass' | 'fail' | 'incomplete' | 'invalid' | 'unavailable';
  validity: string[];
};
