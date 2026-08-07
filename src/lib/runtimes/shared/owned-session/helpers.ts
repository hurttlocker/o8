/**
 * Shared helpers for the owned-session primitive.
 *
 * Purely functional — no runtime state, no adapter coupling. Safe to import
 * from store, fleet, or runtime adapters.
 */

import { execFile } from 'node:child_process';
import { access, mkdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  isBridgeSessionAlive,
} from '@/lib/runtime/pty-bridge';
import type { RuntimeSurfaceLifecycle } from '@/lib/fleet/types';
import { truncateText } from '@/lib/util/text';
import { getDataDir } from '@/lib/data-dir-migration';

import type { OwnedRunOutcome, OwnedRunRecord, ParsedRunLog } from './types';

const execFileAsync = promisify(execFile);

// ── Constants ────────────────────────────────────────────────────────────────

export const RUNS_DIR = 'runs';
export const METADATA_FILE = 'session.json';
export const ACTIVE_WINDOW_MS = 10 * 60_000;
export const RECENT_WINDOW_MS = 6 * 60 * 60_000;
export const OWNED_STALE_WINDOW_MS = 24 * 60 * 60_000;
export const OWNED_FLEET_TTL_MS = 20_000;
export const AUTO_RETRY_FRESHNESS_MS = 60_000;
export const DEFAULT_AUTO_RETRY_DELAY_MS = 5_000;
export const MAX_AUTO_RETRIES = 4;

// ── Text helpers ─────────────────────────────────────────────────────────────

export function nowIso() {
  return new Date().toISOString();
}

export function compactText(value: string | null | undefined, max = 120) {
  return truncateText(value, max, { normalizeWhitespace: true });
}

export function previewText(value: string | null | undefined, max = 260) {
  const compact = compactText(value, max);
  return compact || undefined;
}

export function formatClock(timestampIso?: string) {
  if (!timestampIso) return undefined;
  const date = new Date(timestampIso);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

export function shortHome(value: string) {
  return value.replace(`${os.homedir()}/`, '~/');
}

export function relativeAge(timestampIso?: string) {
  if (!timestampIso) return 'just now';
  const ageMs = Math.max(0, Date.now() - new Date(timestampIso).getTime());
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (ageMs < minute) return 'just now';
  if (ageMs < hour) return `${Math.max(1, Math.round(ageMs / minute))}m ago`;
  if (ageMs < day) return `${Math.max(1, Math.round(ageMs / hour))}h ago`;
  return `${Math.max(1, Math.round(ageMs / day))}d ago`;
}

export function lifecycleAvailabilityLabel(availability?: RuntimeSurfaceLifecycle['availability']) {
  switch (availability) {
    case 'running':
      return 'running';
    case 'awaiting-thread':
      return 'awaiting thread';
    case 'ready-for-resume':
      return 'ready for resume';
    default:
      return 'unknown';
  }
}

// ── Filesystem helpers ───────────────────────────────────────────────────────

export async function pathExists(target: string) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(target: string) {
  await mkdir(target, { recursive: true });
}

export { readJsonFile, writeJsonFile } from '@/lib/fs/json';

export function metadataPath(sessionDir: string) {
  return path.join(sessionDir, METADATA_FILE);
}

/**
 * The command line currently running under `pid`, or null when the process
 * is gone. Used to verify a stored PID still belongs to OUR run before
 * signaling it — PIDs get recycled, and `kill(-pid)` against a recycled
 * group leader SIGINTs an innocent process group.
 */
export async function pidCommandLine(pid: number): Promise<string | null> {
  try {
    const { stdout } = await promisify(execFile)('ps', ['-o', 'command=', '-p', String(pid)], { windowsHide: true });
    const line = stdout.trim();
    return line || null;
  } catch {
    return null;
  }
}

// ── Workspace / repo helpers ─────────────────────────────────────────────────

export async function validateWorkspace(targetCwd: string) {
  const expanded = targetCwd.startsWith('~/') ? path.join(os.homedir(), targetCwd.slice(2)) : targetCwd;
  const resolved = path.resolve(expanded);
  const real = await realpath(resolved).catch(() => resolved);
  const allowedRoots = await Promise.all(
    [os.homedir(), getDataDir()].map(async (root) => {
      const resolvedRoot = path.resolve(root);
      return realpath(resolvedRoot).catch(() => resolvedRoot);
    }),
  );
  const isAllowed = allowedRoots.some((root) => {
    const relative = path.relative(root, real);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
  if (!isAllowed) {
    throw new Error('Owned runtime launch is restricted to paths under the home or configured data directory.');
  }

  // Git-toplevel resolution is path NORMALIZATION, not the security boundary —
  // the home-dir check above is. A plain folder that was never git-inited made
  // this throw `Command failed: git -C … rev-parse --show-toplevel`, which
  // killed EVERY runtime launch on the machine with no surfaced error (#1551,
  // live-hit 2026-07-12: fresh laptop, first project folder, nothing could
  // spawn). Fall back to the resolved folder itself — the CLIs run fine in a
  // non-git directory; isolation/worktrees are separately gated on git.
  try {
    const { stdout } = await execFileAsync('git', ['-C', real, 'rev-parse', '--show-toplevel'], {
      windowsHide: true,
      maxBuffer: 256 * 1024,
    });
    return path.resolve(stdout.trim());
  } catch {
    console.warn(`[runtime-launch] ${real} is not a git repository — using the folder as the workspace root (no isolation)`);
    return real;
  }
}

export async function gitValue(repoPath: string, args: string[]) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], {
      windowsHide: true,
      maxBuffer: 256 * 1024,
    });
    const value = stdout.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

export function repoSlugFromOrigin(origin?: string) {
  const value = (origin ?? '').trim();
  if (!value) return undefined;
  const httpsMatch = value.match(/github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/i);
  if (httpsMatch?.[1]) return httpsMatch[1];
  const sshMatch = value.match(/github\.com:([^/]+\/[^/.]+)(?:\.git)?$/i);
  if (sshMatch?.[1]) return sshMatch[1];
  return undefined;
}

export interface RepoContext {
  repoPath: string;
  repoSlug?: string;
  branch?: string;
  head?: string;
  title: string;
}

export async function resolveRepoContext(repoPath: string): Promise<RepoContext> {
  const [branch, head, origin] = await Promise.all([
    gitValue(repoPath, ['branch', '--show-current']),
    gitValue(repoPath, ['rev-parse', 'HEAD']),
    gitValue(repoPath, ['remote', 'get-url', 'origin']),
  ]);

  const repoSlug = repoSlugFromOrigin(origin);
  const repoName = repoSlug?.split('/').pop() ?? path.basename(repoPath);
  const title = branch ? `${repoName} • ${branch}` : repoName;

  return {
    repoPath,
    repoSlug,
    branch,
    head,
    title,
  };
}

// ── Process liveness helpers ────────────────────────────────────────────────

export function isPidAlive(pid?: number) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function isOwnedRunAlive(run?: OwnedRunRecord | null): Promise<boolean> {
  if (!run) return false;
  // A run that already recorded a finish is terminal — never probe it (#1293).
  // The tmux-bridge probe below has a 3s timeout; paying it once per dead run in
  // a flood of resumable corpses (e.g. after a failed best-of-N fan-out) pushes
  // the inventory build past its hard timeout and wedges the observable in
  // "warming" forever. A finished run's process is gone by definition.
  if (run.finishedAt) return false;
  if (isPidAlive(run.pid)) return true;
  if (run.tmuxSession) {
    return isBridgeSessionAlive(run.tmuxSession);
  }
  return false;
}

// ── Outcome / stderr helpers ────────────────────────────────────────────────

export function filterStderrNoise(raw: string, patterns: RegExp[]): string {
  if (!patterns.length) return raw;
  return raw
    .split('\n')
    .filter((line) => !patterns.some((pattern) => pattern.test(line)))
    .join('\n');
}

export function deriveRunOutcome(
  run: OwnedRunRecord,
  parsed: ParsedRunLog,
  stderrRaw: string,
  stderrNoise: RegExp[],
): OwnedRunOutcome {
  if (run.outcome === 'interrupted' || run.interruptRequestedAt) {
    return 'interrupted';
  }
  if (parsed.completedTurn) {
    return 'finished';
  }
  const stderrText = filterStderrNoise(stderrRaw, stderrNoise).toLowerCase();
  if (stderrText.includes('panic') || stderrText.includes('fatal') || stderrText.includes('error')) {
    return 'failed';
  }
  return run.outcome === 'running' ? 'failed' : run.outcome;
}
