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
