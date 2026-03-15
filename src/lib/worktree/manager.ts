/**
 * WorktreeManager — Orchestration Layer for Git Worktree Isolation
 *
 * Manages worktree lifecycle for ALL agent types:
 * - Claude Code: passes through --worktree flag (Claude handles creation natively)
 * - Codex / others: creates and manages worktrees via git commands
 *
 * ~300 lines. Not a git reimplementation — thin orchestration on top of
 * git worktree + agent-specific behavior.
 *
 * Designed to generalize to IsolationProvider (containers, VMs) in 2028.
 *
 * @see https://github.com/hurttlocker/cortex-ide/issues/65
 * @see https://github.com/hurttlocker/cortex-ide/issues/66
 */

import { execFile } from 'node:child_process';
import { access, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  AgentType,
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
    const taskId = sanitizeTaskName(opts.taskName);
    const baseBranch = opts.baseBranch ?? await this.getCurrentBranch();
    const branchName = `worktree/${opts.agentType}/${taskId}`;
    const now = Date.now();

    if (opts.agentType === 'claude-code') {
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
      });

      return info;
    }

    // For Codex and all other agents: we manage the full worktree lifecycle
    const worktreePath = path.join(this.worktreeBase, taskId);

    // Ensure worktree base directory exists
    await mkdir(this.worktreeBase, { recursive: true });

    // Create the worktree + branch
    await execFileAsync('git', [
      'worktree', 'add',
      worktreePath,
      '-b', branchName,
      baseBranch,
    ], { cwd: this.repoRoot, timeout: 30_000 });

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

    // Save metadata
    await this.saveMeta(taskId, {
      id: taskId,
      agentType: opts.agentType,
      baseBranch,
      createdAt: now,
      claudeManaged: false,
      taskName: opts.taskName,
    });

    // Run project setup unless skipped
    if (!opts.skipSetup) {
      info.status = 'setup';
      await this.runSetup(worktreePath);
    }

    info.status = 'ready';
    return info;
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
   */
  async prune(maxAgeMs = STALE_THRESHOLD_MS): Promise<string[]> {
    const worktrees = await this.list();
    const now = Date.now();
    const pruned: string[] = [];

    for (const wt of worktrees) {
      if (now - wt.lastActivityAt > maxAgeMs && wt.status !== 'active') {
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
      await this.writeMetaStore({ version: 1, worktrees: meta });
    }
  }

  // ── Private Helpers ──

  private async getCurrentBranch(): Promise<string> {
    const { stdout } = await execFileAsync('git', ['branch', '--show-current'], {
      cwd: this.repoRoot,
      timeout: 5000,
    });
    return stdout.trim() || 'main';
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

  private async getLastModified(dirPath: string): Promise<number> {
    try {
      const s = await stat(dirPath);
      return s.mtimeMs;
    } catch {
      return Date.now();
    }
  }

  private inferStatus(lastActivity: number, dirtyFiles: string[], _entry: WorktreeMetaEntry): WorktreeStatus {
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
}
