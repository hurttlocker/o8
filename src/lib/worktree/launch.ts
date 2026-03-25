/**
 * Worktree Launch Integration
 *
 * Wires WorktreeManager into the agent launch flow.
 * - Claude Code: appends --worktree flag (Claude creates + manages worktree natively)
 * - Codex / others: creates managed worktree, sets cwd for agent launch
 *
 * Auto-toggle: worktree isolation defaults ON when repo has active agents,
 * OFF when it's the first/only agent.
 *
 * @see https://github.com/hurttlocker/cortex-ide/issues/68
 */

import { WorktreeManager } from './manager';
import type { AgentType, WorktreeInfo } from './types';
import type { RepoSetupEnvMode } from '@/lib/repos/types';

// Cache managers per repo to avoid re-instantiating
const managers = new Map<string, WorktreeManager>();

function getManager(repoRoot: string): WorktreeManager {
  let mgr = managers.get(repoRoot);
  if (!mgr) {
    mgr = new WorktreeManager(repoRoot);
    managers.set(repoRoot, mgr);
  }
  return mgr;
}

/**
 * Resolve launch options for an agent, potentially creating a worktree.
 *
 * Returns:
 * - { worktree, cwd, claudeWorktreeFlag } if isolation was applied
 * - null if no isolation needed (first agent, or user opted out)
 */
export interface WorktreeLaunchResult {
  /** The worktree metadata */
  worktree: WorktreeInfo;
  /** CWD to launch the agent in (worktree path for managed, repo root for Claude) */
  cwd: string;
  /** For Claude Code: the --worktree flag value to pass */
  claudeWorktreeFlag?: string;
}

export interface WorktreeLaunchOptions {
  /** Repository root path */
  repoRoot: string;
  /** Agent type being launched */
  agentType: AgentType;
  /** Human-readable task name */
  taskName: string;
  /** Base branch (default: current HEAD) */
  baseBranch?: string;
  /** Force isolation on/off. If undefined, auto-decides based on active agents. */
  isolate?: boolean;
  /** Skip project setup (npm install, etc.) */
  skipSetup?: boolean;
  /** How env files should be bootstrapped into the worktree */
  envMode?: RepoSetupEnvMode;
  /** Env files to copy/symlink into the worktree */
  envFiles?: string[];
}

/**
 * Should this launch get worktree isolation?
 *
 * Auto-logic:
 * - If isolate is explicitly set, respect it
 * - If there are already active worktrees for this repo, isolate
 * - If this is the first/only agent, don't isolate (no conflict risk)
 */
export async function shouldIsolate(opts: WorktreeLaunchOptions): Promise<boolean> {
  if (opts.isolate !== undefined) return opts.isolate;

  const mgr = getManager(opts.repoRoot);
  const existing = await mgr.list();
  const active = existing.filter(
    (wt) => wt.status === 'active' || wt.status === 'ready' || wt.status === 'setup',
  );

  // If there's already at least one active worktree, this new agent needs isolation
  return active.length > 0;
}

/**
 * Prepare a worktree for an agent launch.
 *
 * For Claude Code: creates metadata entry, returns flag to pass to CLI.
 * For Codex / others: creates real worktree, runs setup, returns cwd.
 *
 * Returns null if isolation is not needed.
 */
export async function prepareLaunchWorktree(
  opts: WorktreeLaunchOptions,
): Promise<WorktreeLaunchResult | null> {
  const isolate = await shouldIsolate(opts);
  if (!isolate) return null;

  const mgr = getManager(opts.repoRoot);

  const worktree = await mgr.create({
    agentType: opts.agentType,
    taskName: opts.taskName,
    baseBranch: opts.baseBranch,
    skipSetup: opts.skipSetup,
    envMode: opts.envMode,
    envFiles: opts.envFiles,
  });

  if (opts.agentType === 'claude-code') {
    return {
      worktree,
      cwd: opts.repoRoot, // Claude runs from repo root, creates worktree itself
      claudeWorktreeFlag: worktree.id, // Pass as: claude --worktree ${flag}
    };
  }

  return {
    worktree,
    cwd: worktree.path, // Codex and others run inside the worktree directory
  };
}

/**
 * Link a launched agent session to its worktree.
 * Called after successful agent launch to associate the session key.
 */
export async function linkSessionToWorktree(
  repoRoot: string,
  worktreeId: string,
  sessionKey: string,
): Promise<void> {
  const mgr = getManager(repoRoot);
  await mgr.linkSession(worktreeId, sessionKey);
}

/**
 * Get the WorktreeManager for a repo (for direct use in API routes).
 */
export function getWorktreeManager(repoRoot: string): WorktreeManager {
  return getManager(repoRoot);
}

/**
 * Get worktree info for all repos that have active worktrees.
 * Used by the squad panel to show worktree indicators.
 */
export async function getActiveWorktreeSummary(repoRoot: string): Promise<{
  worktrees: WorktreeInfo[];
  conflicts: { safe: boolean; count: number };
  totalDiskUsage: number;
}> {
  const mgr = getManager(repoRoot);
  const [worktrees, conflicts] = await Promise.all([
    mgr.list(),
    mgr.detectConflicts(),
  ]);

  const totalDiskUsage = worktrees.reduce((sum, wt) => sum + (wt.diskUsageBytes ?? 0), 0);

  return {
    worktrees,
    conflicts: {
      safe: conflicts.safe,
      count: conflicts.overlapping.length,
    },
    totalDiskUsage,
  };
}
