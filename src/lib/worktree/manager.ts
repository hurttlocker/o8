/**
 * WorktreeManager — Orchestration Layer for Git Worktree Isolation
 *
 * Manages worktree lifecycle for ALL agent types:
 * - Default path (Codex, Claude Code as of #608): creates and manages the
 *   worktree via git commands, runs a pre-launch rebase onto origin/<base>,
 *   and spawns the agent with cwd=<worktreePath>.
 * - Legacy claude-managed path (only when `opts.managed` is falsy): records
 *   metadata only, lets the Claude CLI handle worktree creation itself via
 *   its `--worktree` flag. Retained so existing in-flight lanes keep working;
 *   new launches pass `managed: true` to force the managed path.
 *
 * Thin orchestration on top of git worktree + agent-specific behavior.
 *
 * Designed to generalize to IsolationProvider (containers, VMs) in 2028.
 *
 * @see https://github.com/hurttlocker/o8/issues/65
 * @see https://github.com/hurttlocker/o8/issues/66
 * @see https://github.com/hurttlocker/o8/issues/608
 */

import { execFile } from 'node:child_process';
import { access, copyFile, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  CleanupOptions,
  ConflictReport,
  CreateWorktreeOptions,
  WorktreeInfo,
  WorktreeMetaEntry,
  WorktreeMetaStore,
  WorktreeStatus,
  WorkspaceIsolationKind,
  WorkspaceIsolationPreference,
} from './types';
import { getApfsCowCapability } from './apfs';
import { resetTrackedWorkspaceChanges } from './clean';
import { hasLiveProcessInside } from './live-process-guard';
import {
  gitCommandErrorMessage,
  shouldClassifyFetchAsOriginMissing,
} from './errors';

const execFileAsync = promisify(execFile);
const WORKTREE_DIR_NAME = '.cortex-worktrees';
const META_FILENAME = '.meta.json';
const CLAUDE_WORKTREE_DIR = '.claude/worktrees';
const STALE_THRESHOLD_MS = 24 * 60 * 60_000; // 24 hours
const AUTO_PRUNE_COOLDOWN_MS = 6 * 60 * 60_000; // 6 hours
const APFS_COW_ENV_FLAG = 'O8_APFS_COW_WORKSPACES';
const APFS_HYDRATION_CANDIDATES = [
  'node_modules',
  '.next/cache',
  '.turbo',
  '.venv',
  'vendor',
  'target',
  'Pods',
  'DerivedData',
];
const NODE_LOCK_FILES = [
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
];
let lastAutoPruneAt = 0;

export type WorktreeRebaseStrategy = 'ours' | 'theirs';

/**
 * Thrown when a worktree cannot be rebased onto its base branch cleanly.
 * Carries the conflicting files + base branch so callers can enqueue a
 * supervisor inbox item and surface the conflict to the operator instead
 * of handing a broken tree to codex (which would generate a diff that
 * reverts already-merged upstream work).
 */
export class WorktreeRebaseConflictError extends Error {
  public readonly baseBranch: string;
  public readonly conflictFiles: string[];
  public readonly worktreePath: string;
  public readonly branch: string;

  constructor(options: {
    baseBranch: string;
    conflictFiles: string[];
    worktreePath: string;
    branch: string;
    message?: string;
  }) {
    super(
      options.message
        ?? `Worktree rebase onto origin/${options.baseBranch} failed with ${options.conflictFiles.length} conflicting file${options.conflictFiles.length === 1 ? '' : 's'}.`,
    );
    this.name = 'WorktreeRebaseConflictError';
    this.baseBranch = options.baseBranch;
    this.conflictFiles = options.conflictFiles;
    this.worktreePath = options.worktreePath;
    this.branch = options.branch;
  }
}

/**
 * Thrown when `git fetch origin <baseBranch>` fails AND the local base
 * branch ref is older than the freshness window (default 5 min), so we
 * can't safely fall back to the local ref — the agent would branch from
 * a stale base and generate a diff full of already-merged upstream work.
 *
 * Caller surfaces this as a `fetch_unreachable` supervisor inbox kind so
 * the operator can run `git fetch` manually, reconnect, and retry.
 */
export class WorktreeFetchUnreachableError extends Error {
  public readonly baseBranch: string;
  public readonly worktreePath: string;
  public readonly branch: string;
  public readonly localRefAgeMs: number;
  public readonly fetchErrorMessage: string;

  constructor(options: {
    baseBranch: string;
    worktreePath: string;
    branch: string;
    localRefAgeMs: number;
    fetchErrorMessage: string;
    message?: string;
  }) {
    super(
      options.message
        ?? `fetch origin ${options.baseBranch} failed and local ref is stale (${Math.round(options.localRefAgeMs / 60_000)} min old).`,
    );
    this.name = 'WorktreeFetchUnreachableError';
    this.baseBranch = options.baseBranch;
    this.worktreePath = options.worktreePath;
    this.branch = options.branch;
    this.localRefAgeMs = options.localRefAgeMs;
    this.fetchErrorMessage = options.fetchErrorMessage;
  }
}

/**
 * Thrown when a freshly-created worktree's tsc fails before we hand it to an
 * agent. Indicates main HEAD is in an internally-inconsistent state (e.g. a
 * non-atomic commit landed the consumer side of a refactor without the
 * matching producer). Catching this here prevents the loop's classic failure
 * mode: every Codex diff appears clean against the broken base, and every
 * subsequent merge fails with tsc errors that don't belong to the agent.
 * See #1107.
 */
export class WorktreeBaseTypecheckError extends Error {
  public readonly baseBranch: string;
  public readonly worktreePath: string;
  public readonly branch: string;
  public readonly tscOutput: string;

  constructor(options: {
    baseBranch: string;
    worktreePath: string;
    branch: string;
    tscOutput: string;
    message?: string;
  }) {
    super(
      options.message
        ?? `Base typecheck failed for ${options.baseBranch} before launch — main HEAD is in an inconsistent state. Commit any pending matching changes (e.g. hook updates) before dispatching.`,
    );
    this.name = 'WorktreeBaseTypecheckError';
    this.baseBranch = options.baseBranch;
    this.worktreePath = options.worktreePath;
    this.branch = options.branch;
    this.tscOutput = options.tscOutput;
  }
}

/** Age threshold for local base-branch ref on fetch failure (5 min). */
const LOCAL_BASE_REF_FRESHNESS_MS = 5 * 60_000;

/**
 * Sanitize a task name into a safe directory/branch name.
 * Replaces spaces with dashes, strips special chars, lowercases.
 */
function sanitizeTaskName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

/**
 * Derive the worktree directory id from create options.
 *
 * When a `packetId` is provided we always use `packet-<sanitized>` so two
 * packets dispatched in parallel never collide on the same dir slot — the
 * old behaviour collapsed every codex packet whose prompt summarised to
 * "context" into `.cortex-worktrees/context`. The `packet-` prefix also
 * matches the regex in `src/lib/runtimes/claude-code.ts` (`\.cortex-worktrees[\/\\]packet-/`)
 * so orchestrator session detection picks them up uniformly across runtimes.
 *
 * Without a packetId (scratch launches, diff-apply, etc.) we fall back to
 * the taskName-derived slug.
 */
function deriveWorktreeId(opts: CreateWorktreeOptions): string {
  const packetSlug = opts.packetId ? sanitizeTaskName(opts.packetId) : '';
  if (packetSlug) return `packet-${packetSlug}`;
  return sanitizeTaskName(opts.taskName);
}

function sanitizeBranchName(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9/_-]/g, '-')
    .replace(/\/+/g, '/')
    .replace(/-+/g, '-')
    .replace(/^[-/.]+|[-/.]+$/g, '')
    .slice(0, 120);
}

function resolveIsolationPreference(opts: CreateWorktreeOptions): WorkspaceIsolationPreference {
  if (opts.isolationPreference) return opts.isolationPreference;
  return process.env[APFS_COW_ENV_FLAG] === '1' ? 'auto' : 'git-worktree';
}

export class WorktreeManager {
  private repoRoot: string;
  private worktreeBase: string;
  private metaPath: string;

  constructor(repoRoot: string) {
    this.repoRoot = repoRoot;
    this.worktreeBase = path.join(repoRoot, WORKTREE_DIR_NAME);
    this.metaPath = path.join(this.worktreeBase, META_FILENAME);
  }

  // ── Create ──

  /**
   * Create a new isolated worktree for an agent.
   * - `opts.managed: true` (default for Codex, and for Claude Code post-#608):
   *   git worktree add + rebase onto origin/<base> + optional setup
   * - `opts.managed: false/undefined` + agentType === 'claude-code':
   *   records metadata only (Claude creates worktree via --worktree flag).
   *   Legacy path — still reachable so existing claude-code lanes in flight
   *   at deploy time keep working until they drain.
   */
  async create(opts: CreateWorktreeOptions): Promise<WorktreeInfo> {
    // Auto-prune stale worktrees (throttled to once per 6 hours)
    if (Date.now() - lastAutoPruneAt > AUTO_PRUNE_COOLDOWN_MS) {
      lastAutoPruneAt = Date.now();
      this.prune().catch(() => {});
    }

    const baseTaskId = deriveWorktreeId(opts);
    let taskId = baseTaskId;
    const baseBranch = opts.baseBranch ?? await this.getCurrentBranch();
    const now = Date.now();

    // Avoid ID collisions — append suffix if already exists in metadata,
    // OR on disk as a worktree directory, OR as a git branch. The metadata-
    // only check missed cases where a prior dispatch attempt created the
    // branch + worktree but never wrote meta (lane retry storms hit this
    // hard — see #TBD). We probe all three and bump the suffix until we
    // find a free slot.
    const existingMeta = await this.loadAllMeta();
    const desiredBranch = sanitizeBranchName(opts.branchName?.trim() || `worktree/${opts.agentType}/${taskId}`);
    const isClaudeUnmanaged = opts.agentType === 'claude-code' && !opts.managed;
    const probeWorktreeDir = (id: string) => isClaudeUnmanaged
      ? path.join(this.repoRoot, CLAUDE_WORKTREE_DIR, id)
      : path.join(this.worktreeBase, id);
    const branchExists = async (name: string) => {
      try {
        await execFileAsync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], { cwd: this.repoRoot, timeout: 5_000 });
        return true;
      } catch {
        return false;
      }
    };
    const dirExists = async (p: string) => {
      try {
        const fs = await import('node:fs/promises');
        await fs.access(p);
        return true;
      } catch {
        return false;
      }
    };
    // When the caller pinned a branchName (lane dispatch passes lane.branch),
    // the branch IS the lane's identity — we can't recompute it to a free
    // value, and adding it to the collision check would spin forever (the
    // branch always exists after the first iteration). Only check branch
    // collisions when the caller didn't pin one.
    const branchPinned = !!opts.branchName?.trim();
    let attemptBranch = desiredBranch;
    let collided = existingMeta[taskId]
      || (await dirExists(probeWorktreeDir(taskId)))
      || (!branchPinned && (await branchExists(attemptBranch)));
    while (collided) {
      const suffix = Math.random().toString(36).slice(2, 6);
      taskId = `${baseTaskId}-${suffix}`;
      // Only re-suffix the branch when the caller didn't pin one. With a pinned
      // lane.branch we let the collision retry recompute the dir id only — the
      // branch name is the lane's identity and must survive the loop.
      attemptBranch = sanitizeBranchName(opts.branchName?.trim() || `worktree/${opts.agentType}/${taskId}`);
      collided = existingMeta[taskId]
        || (await dirExists(probeWorktreeDir(taskId)))
        || (!branchPinned && (await branchExists(attemptBranch)));
    }
    const branchName = attemptBranch;

    if (opts.agentType === 'claude-code' && !opts.managed) {
      // Claude manages its own worktree — we just track it
      const claudeWorktreePath = path.join(this.repoRoot, CLAUDE_WORKTREE_DIR, taskId);

      const info: WorktreeInfo = {
        id: taskId,
        path: claudeWorktreePath,
        branch: branchName,
        baseBranch,
        agentType: 'claude-code',
        status: 'creating',
        createdAt: now,
        lastActivityAt: now,
        dirtyFiles: [],
        claudeManaged: true,
        isolationKind: 'git-worktree',
      };

      await this.saveMeta(taskId, {
        id: taskId,
        agentType: 'claude-code',
        baseBranch,
        createdAt: now,
        claudeManaged: true,
        taskName: opts.taskName,
        branchName,
        status: 'creating',
        isolationKind: 'git-worktree',
      });

      return info;
    }

    // For Codex and all other agents: we manage the full worktree lifecycle
    const worktreePath = path.join(this.worktreeBase, taskId);

    // Ensure worktree base directory exists
    await mkdir(this.worktreeBase, { recursive: true });

    const isolationKind = await this.resolveIsolationKind(resolveIsolationPreference(opts));
    if (isolationKind === 'apfs-cow-clone') {
      return this.createApfsCowClone({
        opts,
        taskId,
        branchName,
        baseBranch,
        worktreePath,
        now,
      });
    }

    // Save metadata with 'creating' status before git operation
    await this.saveMeta(taskId, {
      id: taskId,
      agentType: opts.agentType,
      baseBranch,
      createdAt: now,
      claudeManaged: false,
      taskName: opts.taskName,
      branchName,
      status: 'creating',
      isolationKind: 'git-worktree',
    });

    // Create the worktree + branch
    await execFileAsync('git', [
      'worktree', 'add',
      worktreePath,
      '-b', branchName,
      baseBranch,
    ], { cwd: this.repoRoot, timeout: 30_000 });

    // Rebase onto origin/<baseBranch> before handing the worktree to an agent.
    // The worktree was branched from local <baseBranch>, which may be behind
    // origin after parallel merges. Without this step, the agent's diff against
    // origin/<baseBranch> would show reverts of already-merged upstream work.
    // On conflict we abort + tear down the worktree and throw a typed error so
    // the caller can surface it to the operator instead of spawning codex into
    // a broken tree.
    try {
      await this.rebaseOntoBase(worktreePath, baseBranch, branchName);
    } catch (err) {
      // Best-effort cleanup of the partially-created worktree. Conflict is
      // caller's problem to surface; we just make sure we don't leak a broken
      // tree on disk. Failures here are swallowed — the caller still sees the
      // original rebase error.
      try {
        await execFileAsync('git', ['worktree', 'remove', worktreePath, '--force'], {
          cwd: this.repoRoot,
          timeout: 15_000,
        });
      } catch { /* tree may already be gone */ }
      try {
        await execFileAsync('git', ['branch', '-D', branchName], {
          cwd: this.repoRoot,
          timeout: 5000,
        });
      } catch { /* branch may not exist */ }
      await this.removeMeta(taskId);
      throw err;
    }

    const info: WorktreeInfo = {
      id: taskId,
      path: worktreePath,
      branch: branchName,
      baseBranch,
      agentType: opts.agentType,
      status: 'setup',
      createdAt: now,
      lastActivityAt: now,
      dirtyFiles: [],
      claudeManaged: false,
      isolationKind: 'git-worktree',
    };

    await this.bootstrapEnvFiles(worktreePath, opts);
    await this.injectSafetyHooks(worktreePath);

    // Run project setup unless skipped
    if (!opts.skipSetup) {
      info.status = 'setup';
      await this.updateMetaStatus(taskId, 'setup');
      await this.runSetup(worktreePath);
    }
    await resetTrackedWorkspaceChanges(worktreePath);

    // Pre-launch typecheck gate (#1107). The agent's diff is ALWAYS measured
    // against the worktree's tsc, so a non-atomic commit on main HEAD (consumer
    // side without the matching producer) poisons every packet branched off it:
    // the agent's own work looks clean against the broken base AND the merge
    // fails with tsc errors that don't belong to the agent. Catch that here
    // and refuse to spawn the agent into a broken tree.
    //
    // Opt out with O8_SKIP_PRELAUNCH_TYPECHECK=1 if tsc is too slow / noisy for
    // the dispatch loop. We use the repo-root tsc binary so we don't depend on
    // the worktree having its own node_modules — Node module resolution walks
    // up to the parent.
    if (process.env.O8_SKIP_PRELAUNCH_TYPECHECK !== '1') {
      const tscBin = path.join(this.repoRoot, 'node_modules', '.bin', 'tsc');
      try {
        await execFileAsync(tscBin, ['--noEmit', '--incremental', 'false'], {
          cwd: worktreePath,
          timeout: 180_000,
          maxBuffer: 8 * 1024 * 1024,
        });
      } catch (err) {
        const stdout = (err as { stdout?: unknown })?.stdout;
        const tscOutput = typeof stdout === 'string' ? stdout
          : stdout instanceof Buffer ? stdout.toString('utf8')
          : err instanceof Error ? err.message
          : String(err);
        // Mirror the rebase-conflict cleanup path — tear down the bad tree so
        // we don't leak it on disk; remove the meta so the caller can retry.
        try {
          await execFileAsync('git', ['worktree', 'remove', worktreePath, '--force'], {
            cwd: this.repoRoot,
            timeout: 15_000,
          });
        } catch { /* tree may already be gone */ }
        try {
          await execFileAsync('git', ['branch', '-D', branchName], {
            cwd: this.repoRoot,
            timeout: 5000,
          });
        } catch { /* branch may not exist */ }
        await this.removeMeta(taskId);
        throw new WorktreeBaseTypecheckError({
          baseBranch,
          worktreePath,
          branch: branchName,
          tscOutput: tscOutput.slice(0, 4000),
        });
      }
    }

    info.status = 'ready';
    await this.updateMetaStatus(taskId, 'ready');
    return info;
  }

  private async resolveIsolationKind(
    preference: WorkspaceIsolationPreference,
  ): Promise<WorkspaceIsolationKind> {
    if (preference === 'git-worktree') return 'git-worktree';

    const capability = await getApfsCowCapability(this.repoRoot, this.worktreeBase);
    if (capability.canCowClone) return 'apfs-cow-clone';

    if (preference === 'apfs-cow-clone') {
      throw new Error(capability.reason ?? 'APFS copy-on-write workspaces are unavailable for this repository.');
    }

    if (process.env[APFS_COW_ENV_FLAG] === '1') {
      console.warn(`[worktree] APFS CoW unavailable, falling back to git worktree: ${capability.reason ?? 'unknown reason'}`);
    }
    return 'git-worktree';
  }

  private async createApfsCowClone(params: {
    opts: CreateWorktreeOptions;
    taskId: string;
    branchName: string;
    baseBranch: string;
    worktreePath: string;
    now: number;
  }): Promise<WorktreeInfo> {
    const { opts, taskId, branchName, baseBranch, worktreePath, now } = params;

    await this.saveMeta(taskId, {
      id: taskId,
      agentType: opts.agentType,
      baseBranch,
      createdAt: now,
      claudeManaged: false,
      taskName: opts.taskName,
      branchName,
      status: 'creating',
      isolationKind: 'apfs-cow-clone',
      hydrationPaths: [],
    });

    try {
      await execFileAsync('git', ['clone', '--local', '--no-checkout', this.repoRoot, worktreePath], {
        cwd: this.repoRoot,
        timeout: 60_000,
      });

      const originUrl = await this.getOriginUrl();
      if (originUrl) {
        await execFileAsync('git', ['remote', 'set-url', 'origin', originUrl], {
          cwd: worktreePath,
          timeout: 5000,
        });
      }

      await execFileAsync('git', ['checkout', '-B', branchName, baseBranch], {
        cwd: worktreePath,
        timeout: 30_000,
      });

      try {
        await this.rebaseOntoBase(worktreePath, baseBranch, branchName);
      } catch (err) {
        await this.removeMeta(taskId);
        await rm(worktreePath, { recursive: true, force: true });
        throw err;
      }

      // #1132 — Reset to HEAD so operator WIP can't leak into the agent's
      // commit. Cheap belt-and-braces against any path that could have
      // injected modifications between the clone and the agent dispatch
      // (race window, transient hydration artifacts, future code changes).
      // `git reset --hard HEAD` zeroes any tracked-file modifications and
      // `git clean -fd` removes any stray untracked files. Both are no-ops
      // on a properly clean tree, so this is safe to apply unconditionally
      // and only adds work when there's actually drift to fix.
      // Ignored files (.env, node_modules) are intentionally preserved —
      // hydration / bootstrap fills those next.
      try {
        await resetTrackedWorkspaceChanges(worktreePath);
        await execFileAsync('git', ['clean', '-fd'], {
          cwd: worktreePath,
          timeout: 15_000,
        });
      } catch (err) {
        console.warn(
          `[worktree] HEAD reset after CoW clone failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const info: WorktreeInfo = {
        id: taskId,
        path: worktreePath,
        branch: branchName,
        baseBranch,
        agentType: opts.agentType,
        status: 'setup',
        createdAt: now,
        lastActivityAt: now,
        dirtyFiles: [],
        claudeManaged: false,
        isolationKind: 'apfs-cow-clone',
        hydrationPaths: [],
      };

      const hydrationPaths = await this.hydrateApfsCowAssets(worktreePath);
      info.hydrationPaths = hydrationPaths;
      await this.updateMetaHydrationPaths(taskId, hydrationPaths);

      await this.bootstrapEnvFiles(worktreePath, opts);
      await this.injectSafetyHooks(worktreePath);

      if (!opts.skipSetup) {
        info.status = 'setup';
        await this.updateMetaStatus(taskId, 'setup');
        await this.runSetup(worktreePath);
      }
      await resetTrackedWorkspaceChanges(worktreePath);

      info.status = 'ready';
      await this.updateMetaStatus(taskId, 'ready');
      return info;
    } catch (err) {
      await rm(worktreePath, { recursive: true, force: true }).catch(() => {});
      await this.removeMeta(taskId).catch(() => {});
      throw err;
    }
  }

  // ── Rebase ──

  /**
   * Fetch origin + rebase the worktree's branch onto origin/<baseBranch>.
   * Runs inside the worktree (not the repoRoot) so the rebase affects only
   * the newly-created branch.
   *
   * On rebase conflict: aborts the rebase and throws WorktreeRebaseConflictError
   * with the list of conflicting files. The caller is responsible for tearing
   * down the worktree and surfacing the conflict to the operator.
   *
   * Clean path: logs `[worktree-rebase] <branch> rebased onto origin/<baseBranch>`.
   */
  async rebaseOntoMain(
    worktreePath: string,
    opts: {
      baseBranch?: string;
      branchName?: string;
      strategy?: WorktreeRebaseStrategy;
    } = {},
  ): Promise<void> {
    const baseBranch = opts.baseBranch?.trim() || 'main';
    const branchName = opts.branchName?.trim() || path.basename(worktreePath);
    await this.rebaseOntoBase(worktreePath, baseBranch, branchName, opts.strategy);
  }

  private async rebaseOntoBase(
    worktreePath: string,
    baseBranch: string,
    branchName: string,
    strategy?: WorktreeRebaseStrategy,
  ): Promise<void> {
    // Fetch the latest base ref from origin. Failure is recoverable only if
    // the local base ref is recent — otherwise the agent would branch from a
    // stale base and generate a diff that reverts already-merged upstream
    // work. On stale+unreachable: throw so the caller escalates to a
    // fetch_unreachable supervisor inbox item.
    try {
      await execFileAsync('git', ['fetch', 'origin', baseBranch, '--quiet'], {
        cwd: worktreePath,
        timeout: 60_000,
      });
    } catch (fetchErr) {
      const fetchErrorMessage = gitCommandErrorMessage(fetchErr);
      if (await shouldClassifyFetchAsOriginMissing(worktreePath, fetchErrorMessage)) {
        // Local-only repo with no origin: keep dispatching. The worktree branch
        // already came off local main at checkout time; there's nothing to
        // rebase onto upstream. The operator pushes manually after merge.
        console.warn(
          `[worktree-rebase] origin not configured for ${baseBranch} — skipping rebase (local-only repo).`,
        );
        return;
      }
      const localRefAgeMs = await this.localBaseRefAgeMs(worktreePath, baseBranch);
      if (localRefAgeMs == null || localRefAgeMs > LOCAL_BASE_REF_FRESHNESS_MS) {
        console.warn(
          `[worktree-rebase] fetch origin ${baseBranch} failed (${fetchErrorMessage}) and local ${baseBranch} ref is ${localRefAgeMs == null ? 'missing' : `${Math.round(localRefAgeMs / 60_000)} min old`} — escalating as fetch_unreachable.`,
        );
        throw new WorktreeFetchUnreachableError({
          baseBranch,
          worktreePath,
          branch: branchName,
          localRefAgeMs: localRefAgeMs ?? Number.POSITIVE_INFINITY,
          fetchErrorMessage,
        });
      }
      console.warn(
        `[worktree-rebase] fetch origin ${baseBranch} failed (${fetchErrorMessage}); local ref is ${Math.round(localRefAgeMs / 60_000)} min old — rebasing onto local ${baseBranch} instead.`,
      );
    }

    // Prefer origin/<baseBranch> if it exists; fall back to the local ref.
    let rebaseTarget = `origin/${baseBranch}`;
    try {
      await execFileAsync('git', ['rev-parse', '--verify', rebaseTarget], {
        cwd: worktreePath,
        timeout: 5000,
      });
      // #1469 — when LOCAL base is strictly ahead of origin (unpushed merge
      // commits on main), rebasing onto origin linearizes the unpushed merges
      // and conflicts deterministically — every dispatch failed until the
      // operator happened to push. The local ref is the truth the next merge
      // will land on; rebase onto it when it's ahead. (Diverged histories
      // keep origin — a conflict there is real and must surface.)
      try {
        const { stdout: aheadRaw } = await execFileAsync(
          'git',
          ['rev-list', '--count', `${rebaseTarget}..${baseBranch}`],
          { cwd: worktreePath, timeout: 5000 },
        );
        const { stdout: behindRaw } = await execFileAsync(
          'git',
          ['rev-list', '--count', `${baseBranch}..${rebaseTarget}`],
          { cwd: worktreePath, timeout: 5000 },
        );
        const ahead = Number.parseInt(aheadRaw.trim(), 10) || 0;
        const behind = Number.parseInt(behindRaw.trim(), 10) || 0;
        if (ahead > 0 && behind === 0) {
          console.log(
            `[worktree-rebase] local ${baseBranch} is ${ahead} commit(s) ahead of ${rebaseTarget} (not behind) — rebasing onto local ${baseBranch}.`,
          );
          rebaseTarget = baseBranch;
        }
      } catch { /* comparison failed — keep origin target */ }
    } catch {
      rebaseTarget = baseBranch;
    }

    try {
      const rebaseArgs = ['rebase'];
      if (strategy) {
        rebaseArgs.push('-X', strategy);
      }
      rebaseArgs.push(rebaseTarget);
      await execFileAsync('git', rebaseArgs, {
        cwd: worktreePath,
        timeout: 60_000,
      });
      console.log(`[worktree-rebase] ${branchName} rebased onto ${rebaseTarget}`);
    } catch (err) {
      // Collect conflicting files before aborting so the caller can tell
      // the operator exactly what clashed.
      let conflictFiles: string[] = [];
      try {
        const { stdout } = await execFileAsync(
          'git', ['diff', '--name-only', '--diff-filter=U'],
          { cwd: worktreePath, timeout: 5000 },
        );
        conflictFiles = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
      } catch { /* best effort */ }

      try {
        await execFileAsync('git', ['rebase', '--abort'], {
          cwd: worktreePath,
          timeout: 10_000,
        });
      } catch { /* rebase state may already be clean */ }

      const underlying = err instanceof Error ? err.message : String(err);
      console.warn(
        `[worktree-rebase] ${branchName} rebase onto ${rebaseTarget} failed with ${conflictFiles.length} conflict${conflictFiles.length === 1 ? '' : 's'}: ${underlying}`,
      );

      throw new WorktreeRebaseConflictError({
        baseBranch,
        conflictFiles,
        worktreePath,
        branch: branchName,
        message: conflictFiles.length > 0
          ? `Rebase onto ${rebaseTarget} failed. Conflicting files: ${conflictFiles.join(', ')}`
          : `Rebase onto ${rebaseTarget} failed. ${underlying}`,
      });
    }
  }

  /**
   * Return the age (ms) of the local base-branch ref's tip commit. Used to
   * decide whether falling back to the local ref is safe when `git fetch`
   * fails. Returns null if the ref doesn't exist or the timestamp can't be
   * parsed.
   */
  private async localBaseRefAgeMs(
    worktreePath: string,
    baseBranch: string,
  ): Promise<number | null> {
    try {
      const { stdout } = await execFileAsync(
        'git', ['log', '-1', '--format=%ct', baseBranch],
        { cwd: worktreePath, timeout: 5000 },
      );
      const commitUnixSeconds = parseInt(stdout.trim(), 10);
      if (!Number.isFinite(commitUnixSeconds) || commitUnixSeconds <= 0) {
        return null;
      }
      return Date.now() - commitUnixSeconds * 1000;
    } catch {
      return null;
    }
  }

  // ── List ──

  /**
   * List all worktrees (both managed and Claude-native).
   * Combines git worktree list with our metadata.
   *
   * ## Why `withDiskUsage` is opt-in
   *
   * `diskUsageBytes` costs a `du -sk` — a recursive stat of every inode under
   * the worktree (189ms for one 38MB worktree, measured; worse as it grows).
   * It used to be computed unconditionally, and the ws-server's 5-second
   * conflict scan calls `list()`. So an IDLE o8 was recursively walking every
   * worktree on disk twelve times a minute, forever — ~2.1s of pure disk walk
   * per tick with 11 worktrees present, on a tick that fires every 5s.
   *
   * Exactly one caller in the codebase reads `diskUsageBytes`
   * (`getWorktreeStats` in launch.ts). Everyone else — including the conflict
   * report, which never touches the field — was paying for it. It is now off by
   * default; ask for it explicitly if you actually render bytes.
   *
   * Both passes also run their per-worktree probes concurrently. They were
   * serial `await`s in a `for` loop, so the wall time was the SUM of every
   * worktree's git probes rather than the slowest one.
   */
  async list(opts: { withDiskUsage?: boolean } = {}): Promise<WorktreeInfo[]> {
    const [gitWorktrees, meta] = await Promise.all([
      this.gitWorktreeList(),
      this.loadAllMeta(),
    ]);

    const metaResults = await Promise.all(
      Object.entries(meta).map(async ([id, entry]): Promise<WorktreeInfo | null> => {
        const worktreePath = entry.claudeManaged
          ? path.join(this.repoRoot, CLAUDE_WORKTREE_DIR, id)
          : path.join(this.worktreeBase, id);
        const gitWt = gitWorktrees.find((g) => g.path === worktreePath || g.branch?.includes(id));

        // Check if directory actually exists
        const exists = await this.pathExists(worktreePath);
        if (!exists && !entry.claudeManaged) return null; // Cleaned up externally

        const [dirtyFiles, lastActivity, diskUsageBytes] = await Promise.all([
          exists ? this.getDirtyFiles(worktreePath, entry.baseBranch) : Promise.resolve([]),
          exists ? this.getLastModified(worktreePath) : Promise.resolve(entry.createdAt),
          exists && opts.withDiskUsage ? this.getDiskUsage(worktreePath) : Promise.resolve(0),
        ]);
        const status = this.inferStatus(lastActivity, dirtyFiles, entry);
        const isolationKind = entry.isolationKind ?? 'git-worktree';

        return {
          id,
          path: worktreePath,
          branch: entry.branchName ?? gitWt?.branch ?? `worktree/${entry.agentType}/${id}`,
          baseBranch: entry.baseBranch,
          agentType: entry.agentType,
          sessionKey: entry.sessionKey,
          status,
          createdAt: entry.createdAt,
          lastActivityAt: lastActivity,
          diskUsageBytes,
          dirtyFiles,
          claudeManaged: entry.claudeManaged,
          isolationKind,
          hydrationPaths: entry.hydrationPaths ?? [],
        };
      }),
    );

    const results: WorktreeInfo[] = metaResults.filter(
      (entry): entry is WorktreeInfo => entry !== null,
    );

    // Surface worktrees that exist in git but lost their metadata entry
    // (dev-server restart, accidental .meta deletion). Without this fallback,
    // path-based lookups in lane/commands.ts merge path fail with
    // "Worktree not found on disk" even when the worktree is fully on disk
    // and registered with git.
    const knownPaths = new Set(results.map((r) => r.path));
    const orphanResults = await Promise.all(
      gitWorktrees.map(async (gitWt): Promise<WorktreeInfo | null> => {
        if (knownPaths.has(gitWt.path)) return null;
        if (await this.samePath(gitWt.path, this.repoRoot)) return null;
        const exists = await this.pathExists(gitWt.path);
        if (!exists) return null;

        const id = path.basename(gitWt.path);
        const branch = gitWt.branch ?? `worktree/unknown/${id}`;
        const agentType = branch.includes('/codex/') ? 'codex' : 'claude-code';
        const [lastActivity, dirtyFiles] = await Promise.all([
          this.getLastModified(gitWt.path).catch(() => Date.now()),
          this.getDirtyFiles(gitWt.path, 'main').catch(() => []),
        ]);
        const ageMs = Date.now() - lastActivity;
        const status: WorktreeStatus = ageMs > STALE_THRESHOLD_MS
          ? 'stale'
          : dirtyFiles.length > 0 && ageMs < 5 * 60_000
            ? 'active'
            : 'ready';

        return {
          id,
          path: gitWt.path,
          branch,
          baseBranch: 'main',
          agentType,
          sessionKey: undefined,
          status,
          createdAt: lastActivity,
          lastActivityAt: lastActivity,
          diskUsageBytes: 0,
          dirtyFiles,
          claudeManaged: false,
          isolationKind: 'git-worktree',
        };
      }),
    );

    for (const entry of orphanResults) {
      if (entry) results.push(entry);
    }

    // Sort by most recent activity
    results.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    return results;
  }

  /**
   * Get a single worktree by ID.
   */
  async get(worktreeId: string): Promise<WorktreeInfo | null> {
    const all = await this.list();
    return all.find((wt) => wt.id === worktreeId) ?? null;
  }

  // ── Setup ──

  /**
   * Auto-detect project type and run appropriate install command.
   * Skips install if lock file matches the main repo (deps unchanged).
   */
  async runSetup(worktreePath: string): Promise<void> {
    // Node.js — check if deps changed before installing
    const hasPackageLock = await this.pathExists(path.join(worktreePath, 'package-lock.json'));
    const hasPackageJson = await this.pathExists(path.join(worktreePath, 'package.json'));

    if (hasPackageLock) {
      // Check if lock file is identical to main repo (skip install)
      const mainLock = await this.safeReadFile(path.join(this.repoRoot, 'package-lock.json'));
      const wtLock = await this.safeReadFile(path.join(worktreePath, 'package-lock.json'));

      if (mainLock && wtLock && mainLock === wtLock) {
        // Same deps — symlink node_modules from main repo
        try {
          const mainNodeModules = path.join(this.repoRoot, 'node_modules');
          const wtNodeModules = path.join(worktreePath, 'node_modules');
          if (await this.pathExists(wtNodeModules)) return;
          if (await this.pathExists(mainNodeModules)) {
            await execFileAsync('ln', ['-s', mainNodeModules, wtNodeModules], { timeout: 5000 });
            return;
          }
        } catch { /* fall through to npm ci */ }
      }

      await execFileAsync('npm', ['ci', '--prefer-offline'], {
        cwd: worktreePath,
        timeout: 120_000,
        env: { ...process.env, NODE_ENV: 'development' },
      });
    } else if (hasPackageJson) {
      await execFileAsync('npm', ['install'], {
        cwd: worktreePath,
        timeout: 120_000,
        env: { ...process.env, NODE_ENV: 'development' },
      });
    }

    // Python
    if (await this.pathExists(path.join(worktreePath, 'requirements.txt'))) {
      await execFileAsync('pip', ['install', '-r', 'requirements.txt'], {
        cwd: worktreePath,
        timeout: 120_000,
      }).catch(() => { /* pip may not be available */ });
    }

    // Go
    if (await this.pathExists(path.join(worktreePath, 'go.mod'))) {
      await execFileAsync('go', ['mod', 'download'], {
        cwd: worktreePath,
        timeout: 60_000,
      }).catch(() => { /* go may not be available */ });
    }

    // Rust
    if (await this.pathExists(path.join(worktreePath, 'Cargo.toml'))) {
      await execFileAsync('cargo', ['fetch'], {
        cwd: worktreePath,
        timeout: 120_000,
      }).catch(() => { /* cargo may not be available */ });
    }
  }

  private async getOriginUrl(): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync('git', ['config', '--get', 'remote.origin.url'], {
        cwd: this.repoRoot,
        timeout: 5000,
      });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  private async hydrateApfsCowAssets(worktreePath: string): Promise<string[]> {
    const capability = await getApfsCowCapability(this.repoRoot, worktreePath);
    if (!capability.canCowClone) return [];

    const hydrated: string[] = [];
    for (const relativePath of APFS_HYDRATION_CANDIDATES) {
      const sourcePath = path.join(this.repoRoot, relativePath);
      const targetPath = path.join(worktreePath, relativePath);

      if (!(await this.pathExists(sourcePath))) continue;
      if (await this.pathExists(targetPath)) continue;
      if (relativePath === 'node_modules' && !(await this.nodeDependencyInputsMatch(worktreePath))) {
        continue;
      }

      // F36 fast path (#1028): cp -cR of node_modules is O(file count) even
      // under APFS clone-on-write — 50k+ files take 5-10 min. Dispatch packets
      // edit source only and never mutate node_modules, so a symlink to the
      // host's node_modules is functionally equivalent and ~5000x faster.
      // Restricted to node_modules — other candidates (.next/cache, target/,
      // etc.) may legitimately diverge and still want the CoW copy.
      if (relativePath === 'node_modules') {
        try {
          await mkdir(path.dirname(targetPath), { recursive: true });
          await symlink(sourcePath, targetPath);
          hydrated.push(`${relativePath} (symlink)`);
          continue;
        } catch (err) {
          console.warn(
            `[worktree] node_modules symlink failed, falling back to cp -cR: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      try {
        await mkdir(path.dirname(targetPath), { recursive: true });
        await execFileAsync('cp', ['-cR', sourcePath, targetPath], {
          timeout: 120_000,
        });
        hydrated.push(relativePath);
      } catch (err) {
        console.warn(
          `[worktree] APFS hydration skipped for ${relativePath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return hydrated;
  }

  private async nodeDependencyInputsMatch(worktreePath: string): Promise<boolean> {
    const mainPackageJson = await this.safeReadFile(path.join(this.repoRoot, 'package.json'));
    const wtPackageJson = await this.safeReadFile(path.join(worktreePath, 'package.json'));
    if (!mainPackageJson || !wtPackageJson || mainPackageJson !== wtPackageJson) return false;

    for (const lockFile of NODE_LOCK_FILES) {
      const mainLock = await this.safeReadFile(path.join(this.repoRoot, lockFile));
      const wtLock = await this.safeReadFile(path.join(worktreePath, lockFile));
      if (mainLock !== wtLock) return false;
    }

    return true;
  }

  private async bootstrapEnvFiles(worktreePath: string, opts: CreateWorktreeOptions): Promise<void> {
    const envMode = opts.envMode ?? 'copy';
    if (envMode === 'skip') return;

    const envFiles = opts.envFiles?.filter(Boolean) ?? ['.env', '.env.local'];
    for (const envFile of envFiles) {
      const targetPath = path.join(worktreePath, envFile);
      if (await this.pathExists(targetPath)) continue;

      const sourcePath = await this.resolveEnvBootstrapSource(envFile);
      if (!sourcePath) continue;

      try {
        if (envMode === 'symlink') {
          await symlink(sourcePath, targetPath);
        } else {
          await copyFile(sourcePath, targetPath);
        }
      } catch {
        // Keep env bootstrap best-effort; missing env should show in readiness instead of killing creation.
      }
    }
  }

  private async resolveEnvBootstrapSource(envFile: string): Promise<string | null> {
    const directSource = path.join(this.repoRoot, envFile);
    if (await this.pathExists(directSource)) return directSource;

    if (envFile === '.env') {
      const localFallback = path.join(this.repoRoot, '.env.local');
      if (await this.pathExists(localFallback)) return localFallback;
    }

    return null;
  }

  // ── Safety Hook Injection ──

  /**
   * Inject o8 safety hooks into a worktree's .claude/settings.json.
   * Ensures every dispatched agent gets:
   *  - PreToolUse: destructive command blocker
   *  - PostToolUse: typecheck after edits + completion gate
   *
   * Hooks resolve relative to the o8 install (this.repoRoot) so they work
   * regardless of where the user's repo lives.
   */
  private async injectSafetyHooks(worktreePath: string): Promise<void> {
    try {
      const hooksDir = path.join(worktreePath, '.claude');
      await mkdir(hooksDir, { recursive: true });

      const o8Root = this.repoRoot;
      const settings = {
        hooks: {
          PreToolUse: [{
            matcher: '*',
            hooks: [{
              type: 'command',
              command: `node "${path.join(o8Root, 'dist/hooks/claude-code-pretool-hook.js')}"`,
              timeout: 10,
            }],
          }],
          PostToolUse: [
            {
              matcher: 'Write|Edit|MultiEdit',
              hooks: [{
                type: 'command',
                command: `node "${path.join(o8Root, 'dist/hooks/post-edit-typecheck.js')}"`,
                timeout: 35,
              }],
            },
            {
              matcher: 'Stop|TaskComplete',
              hooks: [{
                type: 'command',
                command: `node "${path.join(o8Root, 'dist/hooks/completion-gate.js')}"`,
                timeout: 50,
              }],
            },
          ],
        },
      };

      const settingsPath = path.join(hooksDir, 'settings.json');
      await writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8');

      // Add .claude/ to the worktree's LOCAL git exclude so the injected
      // settings.json never shows up in `git status`, `git add -A`, or any
      // agent's diff. Without this, every Codex/Gemini/opencode packet
      // commits the file by accident (observed on o8-site #8 and #9) — the
      // file then ships scope-creep that has to be reverted in review.
      // Writing to .git/info/exclude is local-only; never affects the
      // upstream .gitignore or other worktrees.
      try {
        const excludePath = path.join(worktreePath, '.git', 'info', 'exclude');
        let existing = '';
        try { existing = await readFile(excludePath, 'utf8'); } catch { /* file may not exist yet */ }
        if (!existing.split('\n').some((line) => line.trim() === '.claude/')) {
          const next = existing.endsWith('\n') || existing.length === 0
            ? `${existing}.claude/\n`
            : `${existing}\n.claude/\n`;
          await mkdir(path.dirname(excludePath), { recursive: true });
          await writeFile(excludePath, next, 'utf8');
        }
      } catch {
        // Non-fatal — the worktree still works, just may leak the file.
      }

      // .git/info/exclude only hides UNTRACKED files. When o8 dispatches into a
      // repo where .claude/settings.json is TRACKED (o8 self-hosting!), the
      // injected hooks show as `M .claude/settings.json` and any `git add -A`
      // (an agent's own commit, or the recovery-salvage auto-commit) ships it as
      // scope creep. `--skip-worktree` hides a TRACKED file's local modifications
      // from `git status` + `git add`, while the agent still reads the hooks.
      // Best-effort: harmlessly errors when the file is untracked (exclude covers
      // that case) or not yet in the index.
      try {
        await execFileAsync('git', ['update-index', '--skip-worktree', '.claude/settings.json'], {
          cwd: worktreePath,
          timeout: 10_000,
        });
      } catch {
        // untracked / not-in-index — the exclude above handles it
      }
    } catch {
      // Best-effort — don't block worktree creation if hook injection fails
      console.log('[worktree] hook injection failed (non-fatal)');
    }
  }

  // ── Conflict Detection ──

  /**
   * Detect file overlaps across all active worktrees.
   * Returns a ConflictReport with overlapping files and severity.
   */
  async detectConflicts(): Promise<ConflictReport> {
    const worktrees = await this.list();
    const active = worktrees.filter((wt) =>
      wt.status === 'active' || wt.status === 'ready' || wt.dirtyFiles.length > 0,
    );

    const overlapping: ConflictReport['overlapping'] = [];

    for (let i = 0; i < active.length; i++) {
      const filesA = new Set(active[i]!.dirtyFiles);
      for (let j = i + 1; j < active.length; j++) {
        for (const file of active[j]!.dirtyFiles) {
          if (filesA.has(file)) {
            overlapping.push({
              file,
              worktreeIds: [active[i]!.id, active[j]!.id],
              severity: 'conflict', // File-level is always conflict; line-level analysis is Phase 2 (#69)
            });
          }
        }
      }
    }

    return { overlapping, safe: overlapping.length === 0 };
  }

  // ── Cleanup ──

  /**
   * Remove a worktree and optionally its branch.
   * Checks for uncommitted changes first and auto-commits to preserve agent work.
   */
  async cleanup(worktreeId: string, opts?: CleanupOptions): Promise<void> {
    const meta = await this.loadAllMeta();
    const entry = meta[worktreeId];

    if (entry?.claudeManaged) {
      // Claude-managed: just remove our metadata; Claude handles its own cleanup
      await this.removeMeta(worktreeId);
      return;
    }

    // #1404 — a blank/dot/traversal worktreeId resolves to the container dir
    // (or above it); the container isn't a git dir, so the preserve path's
    // `git status` WALKS UP to the repo root and `add -A + commit` lands on
    // the operator's main. No lane-lifecycle git write may ever target a
    // registered repo root — refuse the whole cleanup instead.
    const worktreePath = path.join(this.worktreeBase, worktreeId);
    const resolvedTarget = path.resolve(worktreePath);
    const resolvedBase = path.resolve(this.worktreeBase);
    if (
      !worktreeId.trim()
      || resolvedTarget === resolvedBase
      || resolvedTarget === path.resolve(this.repoRoot)
      || !resolvedTarget.startsWith(`${resolvedBase}${path.sep}`)
    ) {
      console.error(`[worktree-prune] REFUSED cleanup for unsafe worktreeId ${JSON.stringify(worktreeId)} → ${resolvedTarget} (repo-root write guard, #1404)`);
      return;
    }

    // Safety: preserve uncommitted agent work before removing
    if (await this.pathExists(worktreePath)) {
      const preserved = await this.preserveUncommittedWork(worktreePath, worktreeId);
      if (preserved === 'skip') return; // Could not save work — abort prune

      // #1103 — a *clean* worktree can still hold committed-but-unmerged work
      // (an agent committed, but the lane was marked no_changes_produced before
      // review and the worktree later went stale). Removing the dir + force-
      // deleting the branch would discard those commits. Copy them into the main
      // repo as a `preserved/<id>` branch first, so disk is still reclaimed but
      // the work survives and is recoverable.
      const committed = await this.preserveCommittedWork(
        worktreePath,
        worktreeId,
        entry?.baseBranch ?? 'main',
        entry?.isolationKind ?? 'git-worktree',
      );
      if (committed === 'skip') return; // Could not preserve commits — abort to avoid loss
    }

    if ((entry?.isolationKind ?? 'git-worktree') === 'apfs-cow-clone') {
      await rm(worktreePath, { recursive: true, force: true });
    } else {
      // Remove the git worktree
      const args = ['worktree', 'remove', worktreePath];
      if (opts?.force) args.push('--force');

      try {
        await execFileAsync('git', args, { cwd: this.repoRoot, timeout: 15_000 });
      } catch (err) {
        // If directory already gone, that's fine
        const msg = err instanceof Error ? err.message : '';
        if (!msg.includes('is not a working tree')) throw err;
      }

      // F39 (#1031): even when `git worktree remove` succeeds OR bails with
      // "is not a working tree" (orphan case — dev-bridge restart wiped git's
      // .git/worktrees registration), the directory itself can still be left
      // on disk. Without this rm, every merge under those conditions leaks the
      // whole packet worktree (~1-3 GB) and disk fills within days.
      if (await this.pathExists(worktreePath)) {
        await rm(worktreePath, { recursive: true, force: true });
      }
    }

    // Optionally delete the branch
    if (opts?.deleteBranch && entry) {
      const branchName = entry.branchName ?? `worktree/${entry.agentType}/${worktreeId}`;
      await execFileAsync('git', ['branch', '-D', branchName], {
        cwd: this.repoRoot,
        timeout: 5000,
      }).catch(() => { /* branch may not exist */ });
    }

    // Remove our metadata
    await this.removeMeta(worktreeId);
  }

  /**
   * Prune all stale worktrees (no activity for maxAgeMs).
   * Skips worktrees that have an active lane (running/reviewing/merging).
   */
  async prune(maxAgeMs = STALE_THRESHOLD_MS): Promise<string[]> {
    const worktrees = await this.list();
    const now = Date.now();
    const pruned: string[] = [];

    // Guard: never prune a worktree bound to a NON-TERMINAL lane. "Active" is
    // the canonical terminal-states truth — every lane whose status is not in
    // {failed, completed, archived} protects its worktree (blocked /
    // awaiting_input / awaiting_orchestrator / reviewing / paused / launching /
    // recovering all count). #1585: the old guard read `listActiveLanes()`
    // AND fell back to prune-guard-free when the registry import threw — a
    // null guard reaped every live worker's worktree. Fail CLOSED now: if the
    // registry can't be read we cannot tell active from terminal, so we abort
    // the whole prune pass rather than reap blind.
    let activeLanePaths: Set<string>;
    try {
      const { listLanes } = await import('@/lib/lane/registry');
      const { isLaneTerminal } = await import('@/lib/lane/terminal-states');
      activeLanePaths = new Set(
        listLanes()
          .filter((l) => !isLaneTerminal(l.status))
          .map((l) => l.worktreePath)
          .filter((p): p is string => Boolean(p)),
      );
    } catch (err) {
      console.warn(
        `[worktree-prune] lane registry unavailable — aborting prune pass (fail closed): ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }

    const handledIds = new Set<string>();
    for (const wt of worktrees) {
      handledIds.add(wt.id);
      if (now - wt.lastActivityAt > maxAgeMs && wt.status !== 'active') {
        // Check if this worktree backs an active lane
        const wtPath = path.join(this.worktreeBase, wt.id);
        if (activeLanePaths.has(wtPath) || activeLanePaths.has(wt.path)) {
          console.log(`[worktree-prune] Skipping ${wt.id} — active lane bound to this worktree`);
          continue;
        }
        // Never delete a worktree that a live process is still cwd'd inside.
        if (await hasLiveProcessInside(wt.path)) {
          console.log(`[worktree-prune] SKIPPED ${wt.id} — live process(es) inside`);
          continue;
        }
        await this.cleanup(wt.id, { force: true, deleteBranch: true });
        pruned.push(wt.id);
      }
    }

    // F39 (#1031): scan the worktree base dir for orphan packet dirs that
    // aren't in meta and aren't in `git worktree list`. These accumulate after
    // dev-bridge restarts or aborted dispatch cycles and don't get reaped by
    // the loop above because list() can't see them. Without this sweep, the
    // disk fills within a few dispatch days (we hit 100% in May 2026).
    try {
      const { readdir } = await import('node:fs/promises');
      const entries = await readdir(this.worktreeBase, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (handledIds.has(entry.name)) continue;
        if (!entry.name.startsWith('packet-')) continue;
        const orphanPath = path.join(this.worktreeBase, entry.name);
        if (activeLanePaths.has(orphanPath)) continue;
        // #1585: an UNKNOWN mtime must mean KEEP, never delete. The old code
        // (`.catch(() => 0)`) turned a failed probe into epoch 0 and fell
        // through to `rm -rf` — a fresh worktree whose stat momentarily failed
        // read as "infinitely old". Probe failure / zero / non-finite → skip.
        const mtime = await this.probeMtimeMs(orphanPath);
        if (mtime === null) {
          console.warn(`[worktree-prune] SKIPPED orphan ${entry.name} — mtime probe failed/unknown (never deleting on unknown age)`);
          continue;
        }
        if (now - mtime <= maxAgeMs) continue;
        // Never delete a worktree that a live process is still cwd'd inside.
        if (await hasLiveProcessInside(orphanPath)) {
          console.log(`[worktree-prune] SKIPPED ${entry.name} — live process(es) inside`);
          continue;
        }
        await rm(orphanPath, { recursive: true, force: true });
        console.log(`[worktree-prune] Reaped orphan ${entry.name} (no meta, no git, age ${Math.round((now - mtime) / 3_600_000)}h)`);
        pruned.push(entry.name);
      }
    } catch (err) {
      console.warn(`[worktree-prune] Orphan scan failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Retention enforcement (Cursor-parity): beyond the operator's max-count /
    // max-total-size limits, reclaim the OLDEST safe worktrees first. "Safe" =
    // not bound to an active/reviewing lane AND no uncommitted changes. Runs on
    // the same throttled prune cadence as the age sweep above.
    const retired = await this.enforceRetentionLimits(activeLanePaths).catch((err) => {
      console.warn(`[worktree-retention] enforcement failed: ${err instanceof Error ? err.message : String(err)}`);
      return [] as string[];
    });
    for (const id of retired) pruned.push(id);

    // Also run git's built-in prune for any orphaned worktrees
    await execFileAsync('git', ['worktree', 'prune'], {
      cwd: this.repoRoot,
      timeout: 10_000,
    }).catch(() => {});

    return pruned;
  }

  /**
   * Enforce the `.cortex-worktrees` retention ceilings (count + total GB).
   *
   * Triple-guarded, in this order — when ANY guard is unsure, the worktree is
   * KEPT, never removed:
   *   1. SAFE-to-remove: the worktree's path must NOT back an active/reviewing
   *      lane (`activeLanePaths` is every non-terminal lane's worktree path).
   *      A path absent from that set is a terminal-lane or orphan worktree.
   *   2. OLDEST-FIRST: candidates are sorted ascending by last activity; only
   *      the oldest are considered for removal, up to what the limits require.
   *   3. CLEAN: `git status --porcelain` must be empty (no uncommitted/untracked
   *      changes). A dirty tree is skipped + logged, never deleted — matching
   *      the "never lose agent work" contract of the rest of this file.
   *
   * `activeLanePaths` is passed in from {@link prune} (single lane-registry read).
   * A `0` limit on either axis means that axis is unbounded (guard off).
   * Returns the ids actually removed.
   */
  private async enforceRetentionLimits(activeLanePaths: Set<string> | null): Promise<string[]> {
    // Fail closed: a null set means the lane-registry read failed, so we can't
    // tell active from terminal. The age sweep tolerates that (24h floor); this
    // path has NO age floor and could reap a clean in-flight worktree — skip
    // the whole pass instead.
    if (activeLanePaths === null) {
      console.warn('[worktree-retention] lane registry unavailable — skipping retention pass (fail closed)');
      return [];
    }
    let maxCount = 0;
    let maxTotalGb = 0;
    try {
      const { resolveWorktreeRetentionSync } = await import('@/lib/operator/defaults');
      const limits = resolveWorktreeRetentionSync();
      maxCount = limits.maxCount;
      maxTotalGb = limits.maxTotalGb;
    } catch {
      // Operator defaults unavailable — no configured ceiling, nothing to do.
      return [];
    }
    if (maxCount <= 0 && maxTotalGb <= 0) return [];

    // Measure disk usage (needed for the size axis). Only candidate worktrees
    // living DIRECTLY under THIS repo's .cortex-worktrees are in scope — this
    // excludes claude-managed trees (.claude/worktrees) and is symlink-safe
    // (macOS /var → /private/var would defeat a plain string prefix match).
    const all = await this.list({ withDiskUsage: maxTotalGb > 0 });
    const inScope = await Promise.all(
      all.map(async (wt) => (await this.samePath(path.dirname(wt.path), this.worktreeBase)) && !activeLanePaths?.has(wt.path)),
    );
    const candidates = all
      .filter((_, i) => inScope[i])
      // #1585: an unknown / zero / non-finite mtime must NOT sort as "oldest"
      // and get reaped first — that ranked the NEWEST worktrees for deletion.
      // Exclude unknown-age candidates from retention entirely.
      .filter((wt) => Number.isFinite(wt.lastActivityAt) && wt.lastActivityAt > 0)
      // Oldest first — the retention victim order.
      .sort((a, b) => a.lastActivityAt - b.lastActivityAt);

    if (candidates.length === 0) return [];

    const maxBytes = maxTotalGb > 0 ? maxTotalGb * 1024 * 1024 * 1024 : 0;
    let liveCount = candidates.length;
    let liveBytes = candidates.reduce((sum, wt) => sum + (wt.diskUsageBytes ?? 0), 0);
    const removed: string[] = [];

    for (const wt of candidates) {
      const overCount = maxCount > 0 && liveCount > maxCount;
      const overSize = maxBytes > 0 && liveBytes > maxBytes;
      if (!overCount && !overSize) break;

      // Guard 3: never delete a worktree with uncommitted work.
      if (await this.hasUncommittedChanges(wt.path)) {
        console.log(`[worktree-retention] Skipping ${wt.id} — uncommitted changes present (refusing to delete dirty worktree)`);
        continue;
      }

      // Guard 4 (#1585): never delete a worktree that a live process is cwd'd
      // inside, no matter how old — deleting a live worker's cwd aborts its turn.
      if (await hasLiveProcessInside(wt.path)) {
        console.log(`[worktree-prune] SKIPPED ${wt.id} — live process(es) inside`);
        continue;
      }

      await this.cleanup(wt.id, { force: true, deleteBranch: true });
      liveCount -= 1;
      liveBytes -= wt.diskUsageBytes ?? 0;
      removed.push(wt.id);
      console.log(
        `[worktree-retention] Reclaimed ${wt.id} (oldest-first; count ${liveCount}/${maxCount || '∞'}, `
        + `size ${(liveBytes / 1024 / 1024 / 1024).toFixed(2)}GB/${maxTotalGb || '∞'})`,
      );
    }

    return removed;
  }

  /**
   * True when the worktree has uncommitted or untracked changes (`git status
   * --porcelain` is non-empty). Fail-safe: if git can't be trusted here — the
   * toplevel isn't this dir (would walk up to the repo root, #1404) or the probe
   * throws — return true so the caller KEEPS the worktree rather than risk a
   * delete over unsaved work.
   */
  private async hasUncommittedChanges(worktreePath: string): Promise<boolean> {
    try {
      const { stdout: toplevelRaw } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
        cwd: worktreePath,
        timeout: 5000,
      });
      if (path.resolve(toplevelRaw.trim()) !== path.resolve(worktreePath)) return true;
      const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
        cwd: worktreePath,
        timeout: 5000,
      });
      return stdout.trim().length > 0;
    } catch {
      return true;
    }
  }

  // ── Link to Agent Session ──

  /**
   * Associate a worktree with an agent session key.
   */
  async linkSession(worktreeId: string, sessionKey: string): Promise<void> {
    const meta = await this.loadAllMeta();
    const entry = meta[worktreeId];
    if (entry) {
      entry.sessionKey = sessionKey;
      if (entry.status === 'creating' || entry.status === 'setup') {
        entry.status = 'active';
      }
      await this.writeMetaStore({ version: 1, worktrees: meta });
    }
  }

  // ── Private Helpers ──

  /**
   * Check for uncommitted changes in a worktree and auto-commit them.
   * Returns 'committed' if work was saved, 'clean' if nothing to save,
   * or 'skip' if we couldn't save and should abort the prune.
   */
  private async preserveUncommittedWork(
    worktreePath: string,
    worktreeId: string,
  ): Promise<'committed' | 'clean' | 'skip'> {
    try {
      // #1404 belt-and-suspenders: even if a caller slips an unsafe path past
      // the cleanup guard, never add/commit unless the git toplevel IS the
      // worktree dir itself — a non-git dir makes git walk up to the repo root
      // and this preserve would commit the OPERATOR'S uncommitted work.
      const { stdout: toplevelRaw } = await execFileAsync(
        'git', ['rev-parse', '--show-toplevel'],
        { cwd: worktreePath, timeout: 5000 },
      );
      if (path.resolve(toplevelRaw.trim()) !== path.resolve(worktreePath)) {
        console.error(`[worktree-prune] REFUSED preserve for ${worktreeId}: git toplevel ${toplevelRaw.trim()} != ${worktreePath} (repo-root write guard, #1404)`);
        return 'skip';
      }

      const { stdout: status } = await execFileAsync(
        'git', ['status', '--porcelain'],
        { cwd: worktreePath, timeout: 5000 },
      );
      if (!status.trim()) return 'clean';

      console.log(`[worktree-prune] ${worktreeId} has uncommitted changes — preserving work`);

      try {
        await execFileAsync(
          'git', ['add', '-A'],
          { cwd: worktreePath, timeout: 10_000 },
        );
        await execFileAsync(
          'git', ['commit', '-m', 'chore: preserve agent work before worktree cleanup'],
          { cwd: worktreePath, timeout: 10_000 },
        );
        console.log(`[worktree-prune] Auto-committed changes in ${worktreeId}`);
        return 'committed';
      } catch {
        console.log(`[worktree-prune] Auto-commit failed for ${worktreeId}, skipping prune to preserve work`);
        return 'skip';
      }
    } catch {
      // git status failed — worktree might already be gone, safe to proceed
      return 'clean';
    }
  }

  /**
   * Preserve committed-but-unmerged work before destroying a worktree (#1103).
   * `preserveUncommittedWork` only saves dirty files; a *clean* worktree can
   * still hold commits that were never merged or pushed (e.g. the agent
   * committed, but the lane was marked no_changes_produced before review). We
   * copy those commits into the main repo under `preserved/<id>` so the dir can
   * still be removed (disk reclaimed) without discarding the work.
   * Returns 'preserved' if commits were saved, 'clean' if HEAD is already merged
   * into base / empty, or 'skip' if preservation failed (caller aborts cleanup).
   */
  private async preserveCommittedWork(
    worktreePath: string,
    worktreeId: string,
    baseBranch: string,
    isolationKind: WorkspaceIsolationKind,
  ): Promise<'preserved' | 'clean' | 'skip'> {
    const base = baseBranch.trim() || 'main';

    let headSha: string;
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
        cwd: worktreePath,
        timeout: 5000,
      });
      headSha = stdout.trim();
      if (!headSha) return 'clean';
    } catch {
      // Not a resolvable git worktree (already gone) — nothing to save.
      return 'clean';
    }

    // If HEAD is already an ancestor of base, the work is merged — o8 rebases
    // before merge, so a merged branch fast-forwards into base. Nothing to do.
    try {
      await execFileAsync('git', ['merge-base', '--is-ancestor', 'HEAD', base], {
        cwd: worktreePath,
        timeout: 10_000,
      });
      return 'clean'; // exit 0 → HEAD ⊆ base
    } catch {
      // exit 1 (HEAD has commits not in base) or unknown base — preserve to be safe.
    }

    const preservedRef = `refs/heads/preserved/${worktreeId}`;
    try {
      if (isolationKind === 'apfs-cow-clone') {
        // Separate object store — copy the commits into the main repo's store.
        await execFileAsync('git', ['fetch', worktreePath, `+HEAD:${preservedRef}`], {
          cwd: this.repoRoot,
          timeout: 30_000,
        });
      } else {
        // Shared object store — the commit is already present; just point a ref.
        await execFileAsync('git', ['update-ref', preservedRef, headSha], {
          cwd: this.repoRoot,
          timeout: 5000,
        });
      }
      console.log(`[worktree-prune] ${worktreeId} had unmerged commits — preserved as branch preserved/${worktreeId} (${headSha.slice(0, 8)})`);
      return 'preserved';
    } catch (err) {
      console.warn(`[worktree-prune] Could not preserve committed work for ${worktreeId}, skipping cleanup to avoid loss: ${err instanceof Error ? err.message : String(err)}`);
      return 'skip';
    }
  }

  private async getCurrentBranch(): Promise<string> {
    try {
      const { stdout } = await execFileAsync('git', ['branch', '--show-current'], {
        cwd: this.repoRoot,
        timeout: 5000,
      });
      return stdout.trim() || 'main';
    } catch {
      return 'main';
    }
  }

  private async gitWorktreeList(): Promise<Array<{ path: string; branch?: string }>> {
    try {
      const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
        cwd: this.repoRoot,
        timeout: 5000,
      });

      const entries: Array<{ path: string; branch?: string }> = [];
      let current: { path: string; branch?: string } | null = null;

      for (const line of stdout.split('\n')) {
        if (line.startsWith('worktree ')) {
          if (current) entries.push(current);
          current = { path: line.slice('worktree '.length) };
        } else if (line.startsWith('branch ') && current) {
          current.branch = line.slice('branch refs/heads/'.length);
        }
      }
      if (current) entries.push(current);

      return entries;
    } catch {
      return [];
    }
  }

  async getDirtyFiles(worktreePath: string, baseBranch?: string): Promise<string[]> {
    try {
      // Three independent git probes with no ordering dependency between them.
      // They used to run SERIALLY — three full process-spawn round trips
      // (~68ms each on the operator's Intel box, so ~204ms per worktree) to
      // answer three questions that could have been asked at the same time.
      // Concurrent: wall time becomes the slowest probe, not the sum.
      //
      // Deliberately NOT collapsed into a single `git diff --name-only HEAD`.
      // That would miss a file that was staged and then reverted in the working
      // tree (index differs from HEAD, working tree does not) — the union of the
      // three probes is the correct definition of "dirty" and is preserved here
      // exactly, including the failure semantics: if either of the first two
      // probes throws, Promise.all rejects and the outer catch returns [], just
      // as it did before. Only the base-branch probe swallows its own error,
      // because the base branch may legitimately not be reachable.
      const [uncommitted, staged, committed] = await Promise.all([
        // Uncommitted changes (working tree vs index)
        execFileAsync('git', ['diff', '--name-only'], {
          cwd: worktreePath,
          timeout: 5000,
        }).then((r) => r.stdout),

        // Staged changes (index vs HEAD)
        execFileAsync('git', ['diff', '--name-only', '--cached'], {
          cwd: worktreePath,
          timeout: 5000,
        }).then((r) => r.stdout),

        // Committed changes since base (if base provided)
        baseBranch
          ? execFileAsync('git', ['diff', '--name-only', `${baseBranch}...HEAD`], {
              cwd: worktreePath,
              timeout: 5000,
            })
              .then((r) => r.stdout)
              .catch(() => '' /* base branch may not be reachable */)
          : Promise.resolve(''),
      ]);

      const allFiles = [...uncommitted.split('\n'), ...staged.split('\n'), ...committed.split('\n')]
        .map((f) => f.trim())
        .filter(Boolean);

      return [...new Set(allFiles)];
    } catch {
      return [];
    }
  }

  /**
   * Recursive disk walk. NOT cheap — `du -sk` stats every inode under the path,
   * and a worktree carries node_modules / .next / target. Measured at 189ms for
   * a single 38MB worktree on the operator's box, and it scales with the tree.
   *
   * The old comment here claimed "fast even for large dirs". It is not, and that
   * claim cost real money: `list()` called this unconditionally, and the 5s
   * conflict scan calls `list()`, so idle o8 was recursively walking every
   * worktree on disk twelve times a minute, forever.
   *
   * Only ever call this behind `list({ withDiskUsage: true })`.
   */
  private async getDiskUsage(dirPath: string): Promise<number> {
    try {
      const { stdout } = await execFileAsync('du', ['-sk', dirPath], { timeout: 5000 });
      const kb = parseInt(stdout.split('\t')[0] ?? '0', 10);
      return kb * 1024;
    } catch {
      return 0;
    }
  }

  private async getLastModified(dirPath: string): Promise<number> {
    try {
      const s = await stat(dirPath);
      return s.mtimeMs;
    } catch {
      return Date.now();
    }
  }

  /**
   * Probe a directory's mtime, returning `null` when the age is UNKNOWN (stat
   * failed, or the mtime is zero/non-finite). Unlike {@link getLastModified},
   * this NEVER masks a failed probe as "now" or "epoch 0" — the caller decides
   * what unknown age means. The prune orphan-sweep uses it so an unknown mtime
   * is KEPT, never treated as infinitely old and reaped (#1585).
   */
  private async probeMtimeMs(dirPath: string): Promise<number | null> {
    try {
      const s = await stat(dirPath);
      return Number.isFinite(s.mtimeMs) && s.mtimeMs > 0 ? s.mtimeMs : null;
    } catch {
      return null;
    }
  }

  private inferStatus(lastActivity: number, dirtyFiles: string[], entry: WorktreeMetaEntry): WorktreeStatus {
    // Preserve explicit lifecycle states tracked in metadata
    if (entry.status === 'creating' || entry.status === 'setup') return entry.status;

    const ageMs = Date.now() - lastActivity;
    if (ageMs > STALE_THRESHOLD_MS) return 'stale';
    if (dirtyFiles.length > 0 && ageMs < 5 * 60_000) return 'active';
    if (dirtyFiles.length > 0) return 'ready';
    return 'ready';
  }

  private async pathExists(p: string): Promise<boolean> {
    try {
      await access(p);
      return true;
    } catch {
      return false;
    }
  }

  private async samePath(a: string, b: string): Promise<boolean> {
    if (a === b) return true;
    try {
      const [realA, realB] = await Promise.all([realpath(a), realpath(b)]);
      return realA === realB;
    } catch {
      return path.resolve(a) === path.resolve(b);
    }
  }

  private async safeReadFile(p: string): Promise<string | null> {
    try {
      return await readFile(p, 'utf-8');
    } catch {
      return null;
    }
  }

  // ── Metadata Persistence ──

  private async loadAllMeta(): Promise<Record<string, WorktreeMetaEntry>> {
    try {
      const raw = await readFile(this.metaPath, 'utf-8');
      const store = JSON.parse(raw) as WorktreeMetaStore;
      return store.worktrees;
    } catch {
      return {};
    }
  }

  private async writeMetaStore(store: WorktreeMetaStore): Promise<void> {
    await mkdir(path.dirname(this.metaPath), { recursive: true });
    await writeFile(this.metaPath, JSON.stringify(store, null, 2), 'utf-8');
  }

  private async saveMeta(id: string, entry: WorktreeMetaEntry): Promise<void> {
    const existing = await this.loadAllMeta();
    existing[id] = entry;
    await this.writeMetaStore({ version: 1, worktrees: existing });
  }

  private async removeMeta(id: string): Promise<void> {
    const existing = await this.loadAllMeta();
    delete existing[id];
    await this.writeMetaStore({ version: 1, worktrees: existing });
  }

  private async updateMetaStatus(id: string, status: WorktreeStatus): Promise<void> {
    const existing = await this.loadAllMeta();
    const entry = existing[id];
    if (entry) {
      entry.status = status;
      await this.writeMetaStore({ version: 1, worktrees: existing });
    }
  }

  private async updateMetaHydrationPaths(id: string, hydrationPaths: string[]): Promise<void> {
    const existing = await this.loadAllMeta();
    const entry = existing[id];
    if (entry) {
      entry.hydrationPaths = hydrationPaths;
      await this.writeMetaStore({ version: 1, worktrees: existing });
    }
  }
}
