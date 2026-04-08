/**
 * Legacy Cortex type definitions
 *
 * The old Cortex Go binary has been removed. These types are retained only
 * because mobile UI components (RecallPanel, MemoryHealth, MemoryPage,
 * MemoryContext, FactCard) still reference them. Once those components are
 * updated or removed, this file should be deleted.
 */

export interface RecallEvidence {
  memoryId: number;
  sourceFile: string;
  sourceLine?: number;
  quote?: string;
}

export interface RecallCard {
  id: number;
  factId: number;
  memoryId: number;
  text: string;
  factType: string;
  factState: string;
  confidence: number;
  relevance: number;
  qualityScore: number;
  sourceTier: string;
  memoryKind: string;
  retrievalVisibility: string;
  evidenceCount: number;
  evidence: RecallEvidence[];
  reasons: string[];
  promptEligible: boolean;
}

export interface CortexFact {
  ID: number;
  MemoryID: number;
  Subject: string;
  Predicate: string;
  Object: string;
  FactType: string;
  Confidence: number;
  DecayRate: number;
  LastReinforced: string;
  SourceQuote: string;
  CreatedAt: string;
  State: string;
  SupersededBy: number | null;
  AgentID: string;
}

export interface CortexStaleFact {
  fact: CortexFact;
  source_file: string;
  imported_at: string;
  age_days?: number;
}

export interface CortexConflict {
  fact1: CortexFact;
  fact2: CortexFact;
  similarity?: number;
  reason?: string;
}

export interface CortexHealthSummary {
  available: boolean;
  error?: string;
  stats: {
    facts: number;
    memories: number;
    storage_bytes: number;
    avg_confidence: number;
    facts_by_type: Record<string, number>;
    growth: {
      memories_24h: number;
      facts_24h: number;
    };
    confidence_distribution: {
      high: number;
      medium: number;
      low: number;
    };
  };
  staleFacts: CortexStaleFact[];
  conflicts: CortexConflict[];
}
