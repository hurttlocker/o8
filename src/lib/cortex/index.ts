/**
 * Cortex Memory — Barrel Export
 *
 * @see https://github.com/hurttlocker/cortex-ide/issues/78
 */

export {
  isCortexAvailable,
  cortexSearch,
  cortexRecall,
  cortexContext,
  cortexFeedback,
  cortexStats,
  cortexStale,
  cortexConflicts,
  cortexReinforce,
  cortexSupersede,
  cortexRetire,
  cortexQuery,
  cortexAnswer,
  getRecallCards,
  getHealthSummary,
  getContextInjection,
} from './client';

export {
  seedFromCodebase,
  seedFromGitHistory,
  seedFromText,
  checkSeedingNeeded,
} from './seed';

export type {
  CortexFact,
  CortexSearchResult,
  CortexStats,
  CortexStaleFact,
  CortexConflict,
  CortexGraphNode,
  CortexGraphEdge,
  CortexGraphResult,
  CortexQueryResult,
  CortexHealthSummary,
  RecallCard,
  RecallItem,
  RecallEvidence,
  RecallDiagnostics,
  RecallFeedbackAction,
  RecallFeedbackResult,
  ContextInjection,
  FactType,
  FactState,
  MemoryKind,
  SourceTier,
  RetrievalVisibility,
  ConfidenceLevel,
} from './types';
