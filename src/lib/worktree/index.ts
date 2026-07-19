/**
 * Worktree Isolation — Barrel Export
 *
 * @see https://github.com/hurttlocker/o8/issues/65
 */

export { WorktreeManager, WorktreeFetchUnreachableError, WorktreeRebaseConflictError } from './manager';
export { WorktreeOriginMissingError } from './errors';
export {
  LEGACY_WORKTREE_DIR_NAME,
  WORKTREE_ROOT_ENV,
  resolveWorktreeRootLayout,
  worktreeRepoKey,
} from './root-layout';

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
  WorkspaceIsolationKind,
  WorkspaceIsolationPreference,
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
