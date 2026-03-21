export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { scanRepo, getChunkStats } from '@/lib/skeleton';

const DEFAULT_ROOT = process.env.CORTEX_IDE_REVIEW_REPO_ROOT || '/Users/marquisehurtt/clawd/repos/cortex-ide';

/**
 * POST /api/panel/skeleton/scan
 *
 * Triggers a skeleton map scan for a workspace.
 * Body: { workspace?: string, includeTests?: boolean }
 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const workspace = (body as { workspace?: string }).workspace || DEFAULT_ROOT;
    const includeTests = (body as { includeTests?: boolean }).includeTests ?? false;
    const chunks = (body as { chunks?: boolean }).chunks !== false;

    const map = await scanRepo({
      repoPath: workspace,
      includeTests,
      chunks,
    });

    const chunkStats = chunks ? getChunkStats(workspace) : null;

    return NextResponse.json({
      status: 'complete',
      files: map.totalFiles,
      symbols: map.totalSymbols,
      lines: map.totalLines,
      ...(chunkStats ? { chunks: chunkStats.chunkCount, chunkTokens: chunkStats.totalTokens } : {}),
      durationMs: map.scanDurationMs,
      workspace,
    });
  } catch (err) {
    console.error('[skeleton] Scan error:', err);
    return NextResponse.json(
      { error: 'Scan failed', detail: String(err) },
      { status: 500 },
    );
  }
}
