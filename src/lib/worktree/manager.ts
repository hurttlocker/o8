/**
 * WorktreeManager — Orchestration Layer for Git Worktree Isolation
 *
 * Manages worktree lifecycle for ALL agent types:
 * - Claude Code: passes through --worktree flag (Claude handles creation natively)
 * - Codex / others: creates and manages worktrees via git commands
 *
 * Thin orchestration on top of git worktree + agent-specific behavior.
 *
 * Designed to generalize to IsolationProvider (containers, VMs) in 2028.
 *
 * @see https://github.com/hurttlocker/cortex-ide/issues/65
 * @see https://github.com/hurttlocker/cortex-ide/issues/66
 */

import { execFile } from 'node:child_process';
import { access, copyFile, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
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
} from './types';

const execFileAsync = promisify(execFile);
const WORKTREE_DIR_NAME = '.cortex-worktrees';
const META_FILENAME = '.meta.json';
const CLAUDE_WORKTREE_DIR = '.claude/worktrees';
const STALE_THRESHOLD_MS = 24 * 60 * 60_000; // 24 hours
const AUTO_PRUNE_COOLDOWN_MS = 6 * 60 * 60_000; // 6 hours
let lastAutoPruneAt = 0;

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
   * Claude Code: records metadata only (Claude creates worktree via --worktree flag)
   * Codex/others: git worktree add + optional setup
   */
  async create(opts: CreateWorktreeOptions): Promise<WorktreeInfo> {
    // Auto-prune stale worktrees (throttled to once per 6 hours)
    if (Date.now() - lastAutoPruneAt > AUTO_PRUNE_COOLDOWN_MS) {
      lastAutoPruneAt = Date.now();
      this.prune().catch(() => {});
    }

    let taskId = sanitizeTaskName(opts.taskName);
    const baseBranch = opts.baseBranch ?? await this.getCurrentBranch();
    const now = Date.now();

    // Avoid ID collisions — append suffix if already exists
    const existingMeta = await this.loadAllMeta();
    if (existingMeta[taskId]) {
      const suffix = Math.random().toString(36).slice(2, 6);
      taskId = `${taskId}-${suffix}`;
    }

    const branchName = sanitizeBranchName(opts.branchName?.trim() || `worktree/${opts.agentType}/${taskId}`);

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
      };

      await this.saveMeta(taskId, {
        id: taskId,
        agentType: 'claude-code',
        baseBranch,
        createdAt: now,
        claudeManaged: true,
        taskName: opts.taskName,
        status: 'creating',
      });

      return info;
    }

    // For Codex and all other agents: we manage the full worktree lifecycle
    const worktreePath = path.join(this.worktreeBase, taskId);

    // Ensure worktree base directory exists
    await mkdir(this.worktreeBase, { recursive: true });

    // Save metadata with 'creating' status before git operation
    await this.saveMeta(taskId, {
      id: taskId,
      agentType: opts.agentType,
      baseBranch,
      createdAt: now,
      claudeManaged: false,
      taskName: opts.taskName,
      status: 'creating',
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
    };

    await this.bootstrapEnvFiles(worktreePath, opts);
    await this.injectSafetyHooks(worktreePath);

    // Run project setup unless skipped
    if (!opts.skipSetup) {
      info.status = 'setup';
      await this.updateMetaStatus(taskId, 'setup');
      await this.runSetup(worktreePath);
    }

    info.status = 'ready';
    await this.updateMetaStatus(taskId, 'ready');
    return info;
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
  private async rebaseOntoBase(
    worktreePath: string,
    baseBranch: string,
    branchName: string,
  ): Promise<void> {
    // Fetch the latest base ref from origin. Failure here is non-fatal —
    // if origin is unreachable we can still try to rebase onto the local
    // base ref and log a warning. The operator's intent is "branch from
    // latest main", and local-only is strictly better than not rebasing.
    try {
      await execFileAsync('git', ['fetch', 'origin', baseBranch, '--quiet'], {
        cwd: worktreePath,
        timeout: 60_000,
      });
    } catch (fetchErr) {
      console.warn(
        `[worktree-rebase] fetch origin ${baseBranch} failed (${fetchErr instanceof Error ? fetchErr.message : 'unknown'}); rebasing onto local ${baseBranch} instead.`,
      );
    }

    // Prefer origin/<baseBranch> if it exists; fall back to the local ref.
    let rebaseTarget = `origin/${baseBranch}`;
    try {
      await execFileAsync('git', ['rev-parse', '--verify', rebaseTarget], {
        cwd: worktreePath,
        timeout: 5000,
      });
    } catch {
      rebaseTarget = baseBranch;
    }

    try {
      await execFileAsync('git', ['rebase', rebaseTarget], {
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

  // ── List ──

  /**
   * List all worktrees (both managed and Claude-native).
   * Combines git worktree list with our metadata.
   */
  async list(): Promise<WorktreeInfo[]> {
    const [gitWorktrees, meta] = await Promise.all([
      this.gitWorktreeList(),
      this.loadAllMeta(),
    ]);

    const results: WorktreeInfo[] = [];

    for (const [id, entry] of Object.entries(meta)) {
      const gitWt = gitWorktrees.find((g) => g.path === entry.id || g.branch?.includes(id));
      const worktreePath = entry.claudeManaged
        ? path.join(this.repoRoot, CLAUDE_WORKTREE_DIR, id)
        : path.join(this.worktreeBase, id);

      // Check if directory actually exists
      const exists = await this.pathExists(worktreePath);
      if (!exists && !entry.claudeManaged) continue; // Cleaned up externally

      const dirtyFiles = exists ? await this.getDirtyFiles(worktreePath, entry.baseBranch) : [];
      const lastActivity = exists ? await this.getLastModified(worktreePath) : entry.createdAt;
      const status = this.inferStatus(lastActivity, dirtyFiles, entry);
      const diskUsageBytes = exists ? await this.getDiskUsage(worktreePath) : 0;

      results.push({
        id,
        path: worktreePath,
        branch: gitWt?.branch ?? `worktree/${entry.agentType}/${id}`,
        baseBranch: entry.baseBranch,
        agentType: entry.agentType,
        sessionKey: entry.sessionKey,
        status,
        createdAt: entry.createdAt,
        lastActivityAt: lastActivity,
        diskUsageBytes,
        dirtyFiles,
        claudeManaged: entry.claudeManaged,
      });
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

    const worktreePath = path.join(this.worktreeBase, worktreeId);

    // Safety: preserve uncommitted agent work before removing
    if (await this.pathExists(worktreePath)) {
      const preserved = await this.preserveUncommittedWork(worktreePath, worktreeId);
      if (preserved === 'skip') return; // Could not save work — abort prune
    }

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

    // Optionally delete the branch
    if (opts?.deleteBranch && entry) {
      const branchName = `worktree/${entry.agentType}/${worktreeId}`;
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

    // Guard: never prune worktrees with active lanes
    let activeLanePaths: Set<string> | null = null;
    try {
      const { listActiveLanes } = await import('@/lib/lane/registry');
      const activeLanes = listActiveLanes();
      activeLanePaths = new Set(
        activeLanes
          .map((l) => l.worktreePath)
          .filter((p): p is string => Boolean(p)),
      );
    } catch {
      // Lane registry not available — skip guard
    }

    for (const wt of worktrees) {
      if (now - wt.lastActivityAt > maxAgeMs && wt.status !== 'active') {
        // Check if this worktree backs an active lane
        const wtPath = path.join(this.worktreeBase, wt.id);
        if (activeLanePaths?.has(wtPath)) {
          console.log(`[worktree-prune] Skipping ${wt.id} — active lane bound to this worktree`);
          continue;
        }
        await this.cleanup(wt.id, { force: true, deleteBranch: true });
        pruned.push(wt.id);
      }
    }

    // Also run git's built-in prune for any orphaned worktrees
    await execFileAsync('git', ['worktree', 'prune'], {
      cwd: this.repoRoot,
      timeout: 10_000,
    }).catch(() => {});

    return pruned;
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
      // Uncommitted changes
      const { stdout: uncommitted } = await execFileAsync('git', ['diff', '--name-only'], {
        cwd: worktreePath,
        timeout: 5000,
      });

      // Staged changes
      const { stdout: staged } = await execFileAsync('git', ['diff', '--name-only', '--cached'], {
        cwd: worktreePath,
        timeout: 5000,
      });

      // Committed changes since base (if base provided)
      let committed = '';
      if (baseBranch) {
        try {
          const { stdout } = await execFileAsync('git', ['diff', '--name-only', `${baseBranch}...HEAD`], {
            cwd: worktreePath,
            timeout: 5000,
          });
          committed = stdout;
        } catch { /* base branch may not be reachable */ }
      }

      const allFiles = [...uncommitted.split('\n'), ...staged.split('\n'), ...committed.split('\n')]
        .map((f) => f.trim())
        .filter(Boolean);

      return [...new Set(allFiles)];
    } catch {
      return [];
    }
  }

  private async getDiskUsage(dirPath: string): Promise<number> {
    try {
      // du -sk returns kilobytes; fast even for large dirs
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
}
