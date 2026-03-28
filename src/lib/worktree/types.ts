/**
 * Worktree Isolation Types
 *
 * Shared types for the WorktreeManager service.
 * Designed to generalize to IsolationProvider (containers, VMs) in 2028.
 */

import type { RepoSetupEnvMode } from '@/lib/repos/types';

export type WorktreeStatus = 'creating' | 'setup' | 'ready' | 'active' | 'stale' | 'merging' | 'cleaning';

export type AgentType = 'claude-code' | 'codex' | (string & {});

/**
 * Metadata for a single worktree.
 */
export interface WorktreeInfo {
  /** Unique worktree identifier (derived from taskName) */
  id: string;
  /** Absolute filesystem path to worktree directory */
  path: string;
  /** Git branch name */
  branch: string;
  /** Branch this was created from */
  baseBranch: string;
  /** Which agent type is using this worktree */
  agentType: AgentType;
  /** Linked agent session key (if running) */
  sessionKey?: string;
  /** Current lifecycle status */
  status: WorktreeStatus;
  /** When the worktree was created */
  createdAt: number;
  /** Last file modification timestamp */
  lastActivityAt: number;
  /** Disk usage in bytes (lazy, computed on demand) */
  diskUsageBytes?: number;
  /** Files modified since worktree creation */
  dirtyFiles: string[];
  /** Whether Claude manages this worktree natively (--worktree flag) */
  claudeManaged: boolean;
}

/**
 * Report of file overlaps across active worktrees.
 */
export interface ConflictReport {
  overlapping: ConflictEntry[];
  /** True if no overlapping files exist */
  safe: boolean;
}

export interface ConflictEntry {
  /** File path relative to repo root */
  file: string;
  /** Which worktrees have modified this file */
  worktreeIds: [string, string];
  /** warning = same file different sections, conflict = overlapping lines */
  severity: 'warning' | 'conflict';
}

/**
 * Options for creating a worktree.
 */
export interface CreateWorktreeOptions {
  /** Agent type (determines creation strategy) */
  agentType: AgentType;
  /** Human-readable task name (used for branch + dir naming) */
  taskName: string;
  /** Explicit branch name to create/bind for this worktree */
  branchName?: string;
  /** Base branch to create from (default: HEAD) */
  baseBranch?: string;
  /** Force a real git worktree even for runtimes that usually self-manage */
  managed?: boolean;
  /** Skip auto-setup (npm install, etc.) */
  skipSetup?: boolean;
  /** How env files should be bootstrapped into the worktree */
  envMode?: RepoSetupEnvMode;
  /** Env files to copy/symlink when bootstrapping */
  envFiles?: string[];
}

/**
 * Options for cleaning up a worktree.
 */
export interface CleanupOptions {
  /** Force removal even with uncommitted changes */
  force?: boolean;
  /** Also delete the branch */
  deleteBranch?: boolean;
}

/**
 * Result of a merge/PR action.
 */
export interface MergeResult {
  /** Action that was taken */
  action: 'pr' | 'merge' | 'discard';
  /** Whether the action succeeded */
  ok: boolean;
  /** Human-readable description */
  note: string;
  /** PR URL if action was 'pr' */
  prUrl?: string;
}

/**
 * Metadata stored in .cortex-worktrees/.meta.json
 */
export interface WorktreeMetaStore {
  version: 1;
  worktrees: Record<string, WorktreeMetaEntry>;
}

export interface WorktreeMetaEntry {
  id: string;
  agentType: AgentType;
  sessionKey?: string;
  baseBranch: string;
  createdAt: number;
  claudeManaged: boolean;
  taskName: string;
  /** Explicit lifecycle status — preserved through inferStatus */
  status?: WorktreeStatus;
}
