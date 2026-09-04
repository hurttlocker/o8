export interface QuickSpeedMetric {
  value?: number | null;
  delta?: string;
  deltaValue?: number | null;
}

export interface QuickScorecard {
  tracks?: {
    speed?: {
      metrics?: Record<string, QuickSpeedMetric>;
    };
  };
}

export function summarizeQuickScorecard(card: QuickScorecard): {
  status: 'ok' | 'regressed' | 'incomplete';
  regressions: Array<{ name: string; deltaValue: number | null }>;
  missing: string[];
};

export function summarizeInteractionReceipt(receipt: Record<string, unknown> | null, failure?: string | null): {
  status: string;
  reason: string | null;
  failed: Array<{ scale: number; metric: string }>;
  regressed: Array<{ scale: number; metric: string }>;
  unavailable: Array<{ scale: number; metric: string; reason: string }>;
  validity: string[];
  falsification?: Array<{
    scale: number;
    injectedDelayMs: number | null;
    injectedDelayApplications: number | null;
    delayExecuted: boolean;
    budgetFailed: boolean;
    skippedReason: string | null;
  }>;
};
