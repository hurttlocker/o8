/**
 * Engineering Brain Indexer barrel — public surface for the worker (#915 NS#2).
 */

export { probeIndexerCli, resetIndexerCliCache, type IndexerCli } from './cli-probe';
export {
  enqueueComments,
  claimNext,
  completeQueueItem,
  failQueueItem,
  pendingQueueDepth,
  type QueueItem,
} from './queue';
export {
  distillComment,
  DISTILL_PROMPT_TEMPLATE,
  type DistilledFact,
  type DistillInput,
  type FactKind,
} from './distill';
export {
  runIndexerWorker,
  type IndexerWorkerOptions,
  type IndexerWorkerSummary,
} from './worker';
