/**
 * GET /api/cortex/project-pulse?repoPath=<absolute-path>[&force=1]
 *
 * Aggregates peer-repo activity (commits, open PRs, open issues) across every
 * Project the given repo belongs to. Read-only — the underlying data is the
 * existing GitHub cache (#899 wave 2).
 *
 * 5-minute in-memory TTL keyed by repoPath; pass `?force=1` to bypass.
 *
 * Response shape:
 *   {
 *     ok: true,
 *     pulses: ProjectPulse[],
 *   }
 *
 * Failure policy: any error returns `{ ok: false, error }` with status 500.
 * Empty / non-project / cache-miss states return `{ ok: true, pulses: [] }` so
 * the Recall Card can simply hide the row.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { resolve } from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { listRepos } from '@/lib/repos/registry';
import { getProjectPulse, type ProjectPulse } from '@/lib/projects/pulse';

interface CacheEntry {
  pulses: ProjectPulse[];
  ts: number;
}

const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

async function resolveRepoIdFromPath(repoPath: string): Promise<string | null> {
  const normalized = (() => {
    try { return resolve(repoPath); } catch { return ''; }
  })();
  if (!normalized) return null;
  const repos = await listRepos().catch(() => []);
  const match = repos.find((r) => {
    try {
      return resolve(r.localPath) === normalized;
    } catch {
      return false;
    }
  });
  return match?.id ?? null;
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const repoPath = params.get('repoPath')?.trim() ?? '';
  if (!repoPath) {
    return NextResponse.json(
      { ok: false, error: 'repoPath is required.' },
      { status: 400 },
    );
  }
  const force = params.get('force') === '1';

  // Cache hit — but only when not forced.
  const cached = cache.get(repoPath);
  if (!force && cached && Date.now() - cached.ts < TTL_MS) {
    return NextResponse.json(
      { ok: true, pulses: cached.pulses },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  }

  try {
    const repoId = await resolveRepoIdFromPath(repoPath);
    if (!repoId) {
      // Repo isn't registered — treat as "no projects" rather than an error.
      cache.set(repoPath, { pulses: [], ts: Date.now() });
      return NextResponse.json(
        { ok: true, pulses: [] },
        { headers: { 'Cache-Control': 'no-store, max-age=0' } },
      );
    }
    const pulses = await getProjectPulse(repoId);
    cache.set(repoPath, { pulses, ts: Date.now() });
    return NextResponse.json(
      { ok: true, pulses },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load project pulse.';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
