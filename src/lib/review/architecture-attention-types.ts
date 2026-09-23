export type ArchitectureAttentionStatus = 'ready' | 'disabled' | 'unavailable' | 'incomplete';

export type ArchitectureReviewLens =
  | 'auth_trust'
  | 'state_persistence'
  | 'async_lifecycle'
  | 'interface_contract'
  | 'ui_behavior'
  | 'tests_docs'
  | 'general';

export interface ArchitectureAttentionItem {
  path: string;
  reviewPath: string;
  rank: number;
  attentionScore: number | null;
  attentionConfidence: number | null;
  lens: ArchitectureReviewLens;
  lensConfidence: number | null;
  signals: string[];
}

export interface ArchitectureAttentionResult {
  ok: true;
  status: ArchitectureAttentionStatus;
  reason: string | null;
  analysisId: string | null;
  items: ArchitectureAttentionItem[];
  model: string | null;
  latencyMs: number | null;
  receiptId: string | null;
  cached: boolean;
  generatedAt: string;
}
