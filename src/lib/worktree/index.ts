/**
 * Worktree Isolation — Barrel Export
 *
 * @see https://github.com/hurttlocker/cortex-ide/issues/65
 */

export { WorktreeManager, WorktreeRebaseConflictError } from './manager';

export {
  prepareLaunchWorktree,
  shouldIsolate,
  linkSessionToWorktree,
  getWorktreeManager,
  getActiveWorktreeSummary,
} from './launch';

export {
  detectFileOverlaps,
  analyzeLineConflict,
  recommendMergeOrder,
  generateConflictReport,
} from './conflicts';

export type {
  WorktreeInfo,
  WorktreeStatus,
  AgentType,
  ConflictReport,
  ConflictEntry,
  CreateWorktreeOptions,
  CleanupOptions,
  MergeResult,
  WorktreeMetaStore,
  WorktreeMetaEntry,
} from './types';

export type {
  WorktreeLaunchResult,
  WorktreeLaunchOptions,
} from './launch';

export type {
  FileConflictDetail,
  EnhancedConflictReport,
  MergeOrderRecommendation,
  LineRange,
} from './conflicts';
