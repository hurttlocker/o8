/**
 * Cortex Memory Types
 *
 * Typed representations of Cortex CLI JSON output.
 * These mirror the Go structs in hurttlocker/cortex.
 */

// ── Fact Types ──

export type FactType =
  | 'config'
  | 'decision'
  | 'identity'
  | 'kv'
  | 'location'
  | 'preference'
  | 'relationship'
  | 'state'
  | 'temporal';

export type FactState = 'active' | 'core' | 'retired' | 'superseded';

export type MemoryKind = 'journal' | 'durable_fact' | 'ephemeral_run_state';

export type SourceTier = 'canonical' | 'derived' | 'journal' | 'transcript' | 'log';

export type RetrievalVisibility = 'primary' | 'evidence_only' | 'archive';

export type ConfidenceLevel = 'high' | 'medium' | 'low';

export interface CortexFact {
  ID: number;
  MemoryID: number;
  Subject: string;
  Predicate: string;
  Object: string;
  FactType: FactType;
  Confidence: number;
  DecayRate: number;
  LastReinforced: string;
  SourceQuote: string;
  CreatedAt: string;
  State: FactState;
  SupersededBy: number | null;
  AgentID: string;
}

// ── Search Results ──

export interface CortexSearchResult {
  content: string;
  source_file: string;
  source_line?: number;
  source_section?: string;
  class?: string;
  score: number;
  snippet: string;
  match_type: 'bm25' | 'semantic' | 'hybrid' | 'rrf';
  memory_id: number;
  fact_ids: number[];
  imported_at: string;
  metadata?: Record<string, unknown>;
}

// ── Stats ──

export interface CortexStats {
  memories: number;
  facts: number;
  sources: number;
  storage_bytes: number;
  avg_confidence: number;
  facts_by_type: Record<FactType, number>;
  freshness: {
    today: number;
    this_week: number;
    this_month: number;
    older: number;
  };
  growth: {
    memories_24h: number;
    memories_7d: number;
    facts_24h: number;
    facts_7d: number;
  };
  alerts: string[];
  confidence_distribution: {
    high: number;
    medium: number;
    low: number;
    total: number;
  };
  date_range: string;
}

// ── Stale Facts ──

export interface CortexStaleFact {
  fact: CortexFact;
  source_file: string;
  imported_at: string;
  age_days?: number;
}

// ── Conflicts ──

export interface CortexConflict {
  fact1: CortexFact;
  fact2: CortexFact;
  similarity?: number;
  reason?: string;
}

// ── Graph ──

export interface CortexGraphNode {
  id: number;
  subject: string;
  predicate: string;
  object: string;
  fact_type: FactType;
  confidence: number;
  state: FactState;
}

export interface CortexGraphEdge {
  source: number;
  target: number;
  relation: string;
}

export interface CortexGraphResult {
  center: CortexGraphNode;
  nodes: CortexGraphNode[];
  edges: CortexGraphEdge[];
}

// ── Query Results ──

export interface CortexQueryResult {
  fact: CortexFact;
  source_file: string;
  imported_at: string;
}

// ── Health Summary (composed for UI) ──

export interface CortexHealthSummary {
  stats: CortexStats;
  staleFacts: CortexStaleFact[];
  conflicts: CortexConflict[];
  available: boolean;
  error?: string;
}

export interface RecallEvidence {
  memoryId: number;
  sourceFile: string;
  sourceLine?: number;
  quote?: string;
}

export interface RecallDiagnostics {
  searched: number;
  factBacked: number;
  journalOnly: number;
  droppedByPolicy: number;
}

// ── Recall Result (composed for UI) ──

export interface RecallItem {
  id: number;
  factId: number;
  memoryId: number;
  text: string;
  factType: FactType | string;
  factState: FactState | string;
  confidence: number;
  relevance: number;
  qualityScore: number;
  sourceTier: SourceTier | string;
  memoryKind: MemoryKind | string;
  retrievalVisibility: RetrievalVisibility | string;
  evidenceCount: number;
  evidence: RecallEvidence[];
  reasons: string[];
  promptEligible: boolean;
}

export interface CortexRecallItemPayload {
  id?: number;
  fact_id?: number;
  memory_id?: number;
  text?: string;
  fact_type?: string;
  fact_state?: string;
  confidence?: number;
  relevance?: number;
  quality_score?: number;
  source_tier?: string;
  memory_kind?: string;
  retrieval_visibility?: string;
  evidence_count?: number;
  evidence?: Array<{
    memory_id?: number;
    source_file?: string;
    source_line?: number;
    quote?: string;
  }>;
  reasons?: string[];
  prompt_eligible?: boolean;
}

export interface CortexRecallResponsePayload {
  items?: CortexRecallItemPayload[];
  diagnostics?: {
    searched?: number;
    fact_backed?: number;
    journal_only?: number;
    dropped_by_policy?: number;
  };
}

export interface CortexContextResponsePayload extends CortexRecallResponsePayload {
  structured_block?: string;
  token_count?: number;
}

export type RecallFeedbackAction = 'reinforce' | 'retire' | 'supersede' | 'dismiss_for_query';

export interface RecallFeedbackResult {
  factId: number;
  action: RecallFeedbackAction;
  status: string;
  relatedFactId?: number;
  query?: string;
  reason?: string;
}

// ── Pre-launch Context ──

export interface ContextInjection {
  facts: RecallItem[];
  contextBlock: string;
  structuredBlock: string;
  factCount: number;
  tokenCount: number;
  diagnostics: RecallDiagnostics;
}

export type RecallCard = RecallItem;
