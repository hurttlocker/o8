/**
 * POST /api/cortex/reingest
 *
 * Re-runs spec ingestion for a single connected repo — the same pass that
 * fires automatically at repo connect (`scheduleSpecIngest` in
 * `lib/repos/registry.ts`). It re-reads the repo's root docs
 * (README / CLAUDE / AGENTS / DESIGN / THEME + docs/*.md) and rewrites them
 * into the Engineering Brain's directive citations. Surfaced by the
 * "Reindex" action in Settings → Indexing.
 *
 * Body: { repoPath: string }  — absolute path of a connected repo.
 *
 * Response:
 *   { ok: true, result: SpecIngestResult }   // scanned/written/deleted counts
 *   { ok: false, error: string }             // unknown repo / ingest failure
 *
 * Gating: `/api/cortex/*` is default-deny in `src/middleware.ts` (loopback
 * origin + ws-token). No allowlist entry — this route is gated like its
 * siblings, and route-coverage.test.ts classifies it `gated` by default.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';

import { findRepoByLocalPath } from '@/lib/repos/registry';
import { ingestRepoSpecs } from '@/lib/cortex/spec-ingest';

export async function POST(request: NextRequest) {
  let repoPath = '';
  try {
    const body = (await request.json()) as { repoPath?: unknown };
    repoPath = typeof body.repoPath === 'string' ? body.repoPath.trim() : '';
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body.' }, { status: 400 });
  }

  if (!repoPath) {
    return NextResponse.json({ ok: false, error: 'repoPath is required.' }, { status: 400 });
  }

  const repo = await findRepoByLocalPath(repoPath).catch(() => null);
  if (!repo) {
    return NextResponse.json(
      { ok: false, error: 'No connected repo matches that path.' },
      { status: 404 },
    );
  }

  try {
    const result = await ingestRepoSpecs(repo.localPath, repo.name);
    return NextResponse.json(
      { ok: true, result },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: `Reindex failed: ${message}` }, { status: 500 });
  }
}
