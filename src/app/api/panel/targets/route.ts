export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';

import { collectSignals } from '@/lib/targeting/signals';
import { scoreTargets, DEFAULT_TOP_N } from '@/lib/targeting/scorer';
import { applyLlmRationales } from '@/lib/targeting/rationale';
import { pickTier } from '@/lib/targeting/routing';
import { replaceScores } from '@/lib/targeting/store';
import { logTriageRun } from '@/lib/targeting/observability';
import type { TargetScore } from '@/lib/targeting/scorer';

type TargetingProgressPhase =
  | 'starting'
  | 'collecting-signals'
  | 'scoring'
  | 'rationales'
  | 'caching'
  | 'complete'
  | 'error';

interface TargetingProgress {
  phase: TargetingProgressPhase;
  label: string;
  filesScanned: number;
  totalFiles: number | null;
  startedAt: string;
  updatedAt: string;
}

interface TargetingJob {
  id: string;
  repoPath: string;
  limit: number;
  rationaleMode: 'heuristic' | 'llm';
  progress: TargetingProgress;
  result: Record<string, unknown> | null;
  error: string | null;
  startedAtMs: number;
}

const targetingJobs = new Map<string, TargetingJob>();
const TARGETING_JOB_TTL_MS = 5 * 60 * 1000;

function withTier(targets: TargetScore[]) {
  return targets.map((t) => ({ ...t, tier: pickTier(t.signals) }));
}

function updateProgress(job: TargetingJob, update: Partial<Omit<TargetingProgress, 'startedAt' | 'updatedAt'>>) {
  job.progress = {
    ...job.progress,
    ...update,
    updatedAt: new Date().toISOString(),
  };
}

function pruneJobs() {
  const now = Date.now();
  for (const [id, job] of targetingJobs) {
    if (now - job.startedAtMs > TARGETING_JOB_TTL_MS) targetingJobs.delete(id);
  }
}

async function runTargetingJob(job: TargetingJob) {
  try {
    updateProgress(job, { phase: 'collecting-signals', label: 'Reading cached skeleton and git churn' });
    const signals = collectSignals(job.repoPath);
    updateProgress(job, {
      phase: 'scoring',
      label: signals.length > 0 ? 'Scoring cached files' : 'No skeleton cache found',
      filesScanned: signals.length,
      totalFiles: signals.length,
    });

    if (signals.length === 0) {
      job.result = {
        ok: true,
        repoPath: job.repoPath,
        count: 0,
        targets: [],
        reason: 'no-skeleton',
        message: 'No skeleton cache for this repo yet — open/scan it first, then re-run the triage.',
      };
      updateProgress(job, { phase: 'complete', label: 'Scan complete' });
      return;
    }

    const scored = scoreTargets(signals, job.limit);
    job.result = {
      ok: true,
      repoPath: job.repoPath,
      count: scored.length,
      scoredAt: new Date().toISOString(),
      partial: job.rationaleMode === 'llm',
      targets: withTier(scored),
    };

    updateProgress(job, {
      phase: job.rationaleMode === 'heuristic' ? 'caching' : 'rationales',
      label: job.rationaleMode === 'heuristic' ? 'Caching ranked targets' : 'Writing rationale summaries',
    });
    const targets = job.rationaleMode === 'heuristic' ? scored : await applyLlmRationales(scored);
    logTriageRun(job.repoPath, targets, job.rationaleMode);
    updateProgress(job, { phase: 'caching', label: 'Caching ranked targets' });
    try {
      replaceScores(job.repoPath, targets);
    } catch (err) {
      console.warn('[targeting] failed to cache scores:', err instanceof Error ? err.message : err);
    }

    job.result = {
      ok: true,
      repoPath: job.repoPath,
      count: targets.length,
      scoredAt: new Date().toISOString(),
      partial: false,
      targets: withTier(targets),
    };
    updateProgress(job, { phase: 'complete', label: 'Scan complete' });
  } catch (err) {
    job.error = err instanceof Error ? err.message : 'targeting failed';
    job.result = { ok: false, error: job.error };
    updateProgress(job, { phase: 'error', label: 'Triage failed' });
  }
}

function startTargetingJob(repoPath: string, limit: number, rationaleMode: 'heuristic' | 'llm') {
  pruneJobs();
  const now = new Date().toISOString();
  const job: TargetingJob = {
    id: randomUUID(),
    repoPath,
    limit,
    rationaleMode,
    progress: {
      phase: 'starting',
      label: 'Starting scan',
      filesScanned: 0,
      totalFiles: null,
      startedAt: now,
      updatedAt: now,
    },
    result: null,
    error: null,
    startedAtMs: Date.now(),
  };
  targetingJobs.set(job.id, job);
  setTimeout(() => {
    void runTargetingJob(job);
  }, 0);
  return job;
}

/**
 * The Targeting Machine — GET the ranked "where to point your agents" list for a
 * repo. Deliberately cheap: reads the pre-computed skeleton signals + one git
 * pass, scores with the deterministic heuristic, caches, and returns the top-N.
 * Gated under /api/panel/* (loopback + ws-token). No throw — structured errors.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const raw = searchParams.get('repoPath') || searchParams.get('workspace') || process.cwd();
  const repoPath = raw.startsWith('~') ? raw.replace('~', homedir()) : raw;
  const limit = Math.max(1, Math.min(200, parseInt(searchParams.get('limit') || '', 10) || DEFAULT_TOP_N));
  const rationaleMode = searchParams.get('rationales') === 'heuristic' ? 'heuristic' as const : 'llm' as const;

  if (searchParams.get('mode') === 'start') {
    const job = startTargetingJob(repoPath, limit, rationaleMode);
    return NextResponse.json({ ok: true, jobId: job.id, progress: job.progress });
  }

  const jobId = searchParams.get('jobId');
  if (jobId) {
    pruneJobs();
    const job = targetingJobs.get(jobId);
    if (!job || job.repoPath !== repoPath) {
      return NextResponse.json({ ok: false, error: 'targeting scan not found' }, { status: 404 });
    }
    return NextResponse.json({
      ok: job.error ? false : true,
      jobId: job.id,
      progress: job.progress,
      ...(job.result ?? {}),
    });
  }

  try {
    const signals = collectSignals(repoPath);
    if (signals.length === 0) {
      return NextResponse.json({
        ok: true,
        repoPath,
        count: 0,
        targets: [],
        reason: 'no-skeleton',
        message: 'No skeleton cache for this repo yet — open/scan it first, then re-run the triage.',
      });
    }

    const scored = scoreTargets(signals, limit);
    // The rationale money-shot: upgrade the top files' one-liners with the cheap
    // triage model (heuristic fallback per file). Opt out with ?rationales=heuristic
    // for an instant heuristic-only list.
    const targets = rationaleMode === 'heuristic' ? scored : await applyLlmRationales(scored);
    logTriageRun(repoPath, targets, rationaleMode);
    try {
      replaceScores(repoPath, targets);
    } catch (err) {
      // Cache write is best-effort — never fail the triage over it.
      console.warn('[targeting] failed to cache scores:', err instanceof Error ? err.message : err);
    }

    return NextResponse.json({
      ok: true,
      repoPath,
      count: targets.length,
      scoredAt: new Date().toISOString(),
      // Stamp each file's dispatch tier (cheap triage vs premium action) so the
      // row can show the chip + the Dispatch button knows where it'll route.
      targets: withTier(targets),
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'targeting failed' },
      { status: 500 },
    );
  }
}
