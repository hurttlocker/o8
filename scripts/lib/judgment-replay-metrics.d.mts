// Types for judgment-replay-metrics.mjs (allowJs is off repo-wide).
export interface ScoredRow {
  p: number;
  y: 0 | 1;
  packet: string;
}
export interface ReliabilityBin {
  low: number;
  high: number;
  n: number;
  meanPredicted: number | null;
  observedRate: number | null;
}
export interface LeaveOnePacketOut {
  folds: number;
  scoredFolds: number;
  falseAlarms: number;
  negativesEvaluated: number;
  misses: number;
  positivesEvaluated: number;
  rowsWithoutTrainingPositive: number;
  thresholds: Array<{ packet: string; threshold: number }>;
}
export declare function auc(rows: ScoredRow[]): number | null;
export declare function brier(rows: ScoredRow[]): number | null;
export declare function reliabilityTable(rows: ScoredRow[], bins?: number): ReliabilityBin[];
export declare function leaveOnePacketOutCatchAll(rows: ScoredRow[]): LeaveOnePacketOut;
export declare function summarize(rows: ScoredRow[]): {
  n: number;
  positives: number;
  negatives: number;
  auc: number | null;
  brier: number | null;
  reliability: ReliabilityBin[];
  leaveOnePacketOut: LeaveOnePacketOut;
};
