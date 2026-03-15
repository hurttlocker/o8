/**
 * Cortex Memory — Barrel Export
 *
 * @see https://github.com/hurttlocker/cortex-ide/issues/78
 */

export {
  isCortexAvailable,
  cortexSearch,
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
  ContextInjection,
  FactType,
  FactState,
  ConfidenceLevel,
} from './types';
