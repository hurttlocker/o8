import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { Lane } from '@/lib/lane/types';

const execFileAsync = promisify(execFile);

const COMMAND_MAX_BUFFER = 4 * 1024 * 1024;
const AUTO_COMMIT_AFTER_VERIFIED_IDLE_MS = 2 * 60_000;
const SELF_REVIEW_HARD_DEADLINE_MS = 5 * 60_000;
const STALL_SIGNAL_MS = 10 * 60_000;
const MIN_PROBE_INTERVAL_MS = 15_000;

interface TranscriptEntryLike {
  id: string;
  role: string;
  text: string;
  toolName?: string;
}

type LaneSnapshot = Pick<
  Lane,
  'id' | 'label' | 'repoPath' | 'worktreePath' | 'baseBranch' | 'status' | 'packetId' | 'runtime' | 'lastEventAt'
>;

interface GuardState {
  firstObservedAt: number;
  initialHead: string | null;
  lastProbeAt: number;
  lastEditSignature: string | null;
  lastEditAt: number;
  verifiedAt: number | null;
  signalSentAt: number | null;
  forceStartedAt: number | null;
}

interface WorktreeSnapshot {
  cwd: string;
  head: string | null;
  dirty: boolean;
  hasDiffAgainstBase: boolean;
  changedPaths: string[];
  signature: string;
  latestFileMtimeMs: number | null;
}

export interface SelfReviewStallProbeInput {
  surfaceId: string;
  lane: LaneSnapshot;
  transcript: TranscriptEntryLike[];
  startedAt?: number | null;
  now?: number;
}

export type SelfReviewStallDecision =
  | { kind: 'none' }
  | {
      kind: 'signal-stall';
      reason: string;
      runningMs: number;
      head: string | null;
    }
  | {
      kind: 'force-review';
      reason: string;
      idleMs: number;
      verification: VerificationEvidence;
      cwd: string;
    };

interface VerificationEvidence {
  typecheckPassed: boolean;
  lintPassed: boolean;
  selfReviewLikely: boolean;
}

const states = new Map<string, GuardState>();

export function resetSelfReviewStallGuard(surfaceId: string): void {
  states.delete(surfaceId);
}

export async function probeSelfReviewStall(
  input: SelfReviewStallProbeInput,
): Promise<SelfReviewStallDecision> {
  const now = input.now ?? Date.now();
  const lane = input.lane;
  if (lane.runtime !== 'codex' || lane.status !== 'running' || !lane.packetId) {
    resetSelfReviewStallGuard(input.surfaceId);
    return { kind: 'none' };
  }

  const existing = states.get(input.surfaceId);
  if (existing && now - existing.lastProbeAt < MIN_PROBE_INTERVAL_MS) {
    return { kind: 'none' };
  }

  const snapshot = await readWorktreeSnapshot(lane.worktreePath ?? lane.repoPath, lane.baseBranch);
  const hasCommitWorthyWork = snapshot.dirty || snapshot.hasDiffAgainstBase;
  if (!hasCommitWorthyWork) {
    resetSelfReviewStallGuard(input.surfaceId);
    return { kind: 'none' };
  }

  const state = existing ?? {
    firstObservedAt: input.startedAt ?? parseDateMs(lane.lastEventAt) ?? now,
    initialHead: snapshot.head,
    lastProbeAt: 0,
    lastEditSignature: null,
    lastEditAt: snapshot.latestFileMtimeMs ?? now,
    verifiedAt: null,
    signalSentAt: null,
    forceStartedAt: null,
  };
  states.set(input.surfaceId, state);
  state.lastProbeAt = now;

  const previousSignature = state.lastEditSignature;
  if (snapshot.signature !== previousSignature) {
    state.lastEditSignature = snapshot.signature;
    state.lastEditAt = snapshot.latestFileMtimeMs ?? now;
    state.forceStartedAt = null;
    if (state.verifiedAt && snapshot.latestFileMtimeMs && snapshot.latestFileMtimeMs > state.verifiedAt + 1000) {
      state.verifiedAt = null;
    }
  }

  const verification = detectVerificationEvidence(input.transcript);
  if (verification.typecheckPassed && verification.lintPassed && !state.verifiedAt) {
    state.verifiedAt = now;
  }

  const runningMs = now - state.firstObservedAt;
  if (
    !state.signalSentAt
    && runningMs >= STALL_SIGNAL_MS
    && snapshot.head === state.initialHead
  ) {
    state.signalSentAt = now;
    return {
      kind: 'signal-stall',
      reason: 'Codex has active transcript updates but has not committed after 10 minutes.',
      runningMs,
      head: snapshot.head,
    };
  }

  if (state.forceStartedAt) {
    return { kind: 'none' };
  }

  const idleMs = now - Math.max(state.lastEditAt, state.verifiedAt ?? 0);
  if (state.verifiedAt && idleMs >= AUTO_COMMIT_AFTER_VERIFIED_IDLE_MS) {
    state.forceStartedAt = now;
    return {
      kind: 'force-review',
      reason: 'Transcript shows typecheck and lint passed, and no file edits landed for two minutes.',
      idleMs,
      verification,
      cwd: snapshot.cwd,
    };
  }

  const selfReviewIdleMs = now - state.lastEditAt;
  if (
    verification.selfReviewLikely
    && selfReviewIdleMs >= SELF_REVIEW_HARD_DEADLINE_MS
  ) {
    state.forceStartedAt = now;
    return {
      kind: 'force-review',
      reason: 'Codex appears stuck in self-review after the last file edit hard deadline.',
      idleMs: selfReviewIdleMs,
      verification,
      cwd: snapshot.cwd,
    };
  }

  return { kind: 'none' };
}

function detectVerificationEvidence(entries: TranscriptEntryLike[]): VerificationEvidence {
  const nonUserText = entries
    .filter((entry) => entry.role !== 'user')
    .map((entry) => `${entry.toolName ?? ''}\n${entry.text ?? ''}`)
    .join('\n');
  const normalized = nonUserText.toLowerCase();

  return {
    typecheckPassed: commandSucceeded(normalized, [
      'npm run typecheck',
      'npx tsc --noemit',
      'tsc --noemit',
    ]),
    lintPassed: commandSucceeded(normalized, [
      'npm run lint',
      'npx eslint',
      'eslint ',
      'targeted lint',
    ]),
    selfReviewLikely: /\bself[- ]review\b|\bgit diff main\.\.\.head\b|\breviewing (my|the) diff\b/.test(normalized),
  };
}

function commandSucceeded(text: string, commandNeedles: string[]): boolean {
  for (const needle of commandNeedles) {
    const index = text.indexOf(needle.toLowerCase());
    if (index === -1) continue;
    const window = text.slice(index, index + 6000);
    if (/(process exited with code 0|exit code 0|exited with code 0|completed successfully|no errors|0 errors|passed)/.test(window)) {
      return true;
    }
  }
  return false;
}

async function readWorktreeSnapshot(cwd: string, baseBranch?: string | null): Promise<WorktreeSnapshot> {
  const [head, porcelain, hasDiffAgainstBase] = await Promise.all([
    readGitStdout(cwd, ['rev-parse', 'HEAD']).catch(() => null),
    readGitStdout(cwd, ['status', '--porcelain=v1']).catch(() => ''),
    hasDiff(cwd, baseBranch?.trim() || 'main'),
  ]);
  const changedPaths = parsePorcelainPaths(porcelain);
  const fileStats = await Promise.all(
    changedPaths.map(async (filePath) => {
      try {
        const fileStat = await stat(path.join(cwd, filePath));
        return `${filePath}:${Math.trunc(fileStat.mtimeMs)}:${fileStat.size}`;
      } catch {
        return `${filePath}:missing`;
      }
    }),
  );
  const latestFileMtimeMs = fileStats.length > 0
    ? await latestChangedPathMtime(cwd, changedPaths)
    : null;

  return {
    cwd,
    head: head?.trim() || null,
    dirty: porcelain.trim().length > 0,
    hasDiffAgainstBase,
    changedPaths,
    signature: [head?.trim() ?? '', porcelain, ...fileStats].join('\n'),
    latestFileMtimeMs,
  };
}

async function hasDiff(cwd: string, baseRef: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['diff', '--quiet', `${baseRef}...HEAD`], {
      cwd,
      maxBuffer: COMMAND_MAX_BUFFER,
    });
    return false;
  } catch (error) {
    const status = (error as { status?: number | null }).status;
    if (status === 1) return true;
  }

  try {
    await execFileAsync('git', ['diff', '--quiet', 'HEAD~1..HEAD'], {
      cwd,
      maxBuffer: COMMAND_MAX_BUFFER,
    });
    return false;
  } catch (error) {
    const status = (error as { status?: number | null }).status;
    return status === 1;
  }
}

async function readGitStdout(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    maxBuffer: COMMAND_MAX_BUFFER,
  });
  return stdout;
}

function parsePorcelainPaths(output: string): string[] {
  const paths = new Set<string>();
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const rawPath = trimmed.slice(3).trim();
    const renamedPath = rawPath.includes(' -> ')
      ? rawPath.split(' -> ').at(-1)?.trim()
      : rawPath;
    const unquoted = renamedPath?.replace(/^"|"$/g, '');
    if (unquoted) {
      paths.add(unquoted);
    }
  }
  return [...paths];
}

async function latestChangedPathMtime(cwd: string, paths: string[]): Promise<number | null> {
  let latest: number | null = null;
  for (const filePath of paths) {
    try {
      const fileStat = await stat(path.join(cwd, filePath));
      latest = latest === null ? fileStat.mtimeMs : Math.max(latest, fileStat.mtimeMs);
    } catch {
      continue;
    }
  }
  return latest;
}

function parseDateMs(value?: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
