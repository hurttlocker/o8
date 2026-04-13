export interface CortexConfig {
  embedModel: string;
  enrichModel: string;
  classifyModel: string;
  expandModel: string;
  llmProvider: string;
  llmApiKey: string;
  llmApiKeySet: boolean;
  configPath: string;
  dbPath: string;
  sourceBoostCount: number;
  recallEnabled?: boolean;
  recallMaxResults?: number;
  recallTokenBudget?: number;
  recallMinConfidence?: number;
}

export interface CortexStats {
  memories: number;
  facts: number;
  sources: number;
  storageMb: string;
  avgConfidence: string;
  embeddings: number;
  embedCoverage: string;
  factsByType: Record<string, number>;
  confidenceDistribution: Record<string, number>;
  growth: Record<string, number>;
}

export interface ConflictFact {
  id: number;
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  source: string;
  lastSeen?: string;
  factType?: string;
}

export interface ConflictPair {
  factA: ConflictFact;
  factB: ConflictFact;
}
