export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { homedir } from 'node:os';

import { collectSignals } from '@/lib/targeting/signals';
import { scoreTargets, DEFAULT_TOP_N } from '@/lib/targeting/scorer';
import { applyLlmRationales } from '@/lib/targeting/rationale';
import { replaceScores } from '@/lib/targeting/store';

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
    const targets = searchParams.get('rationales') === 'heuristic'
      ? scored
      : await applyLlmRationales(scored);
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
      targets,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'targeting failed' },
      { status: 500 },
    );
  }
}
