export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getRenderedSkeletonCached, searchSymbols } from '@/lib/skeleton';
import { getAllCached } from '@/lib/skeleton/store';
import { ensureBooted, triggerScanIfStale } from '@/lib/skeleton/autoscan';

const DEFAULT_ROOT = process.env.CORTEX_IDE_REVIEW_REPO_ROOT || process.cwd();

/**
 * GET /api/panel/skeleton?workspace=<path>&search=<query>
 *
 * Returns the skeleton map + rendered text for a workspace.
 * If `search` is provided, returns symbol search results instead.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const workspace = searchParams.get('workspace') || DEFAULT_ROOT;
  const search = searchParams.get('search');

  // Ensure boot scan has fired (no-op after first call)
  ensureBooted();
  // Trigger rescan if this workspace's cache is stale
  triggerScanIfStale(workspace);

  try {
    // Symbol search mode
    if (search) {
      const results = searchSymbols(workspace, search, 15);
      return NextResponse.json({ results, query: search, workspace });
    }

    // Full map mode
    const rendered = getRenderedSkeletonCached(workspace);
    if (!rendered) {
      return NextResponse.json({
        map: null,
        rendered: null,
        message: 'No skeleton cache. POST /api/panel/skeleton/scan to trigger a scan.',
      });
    }

    const skeletons = getAllCached(workspace);
    const totalSymbols = skeletons.reduce((sum, f) => sum + f.symbols.length, 0);
    const totalLines = skeletons.reduce((sum, f) => sum + f.lineCount, 0);

    return NextResponse.json({
      rendered,
      stats: {
        fileCount: skeletons.length,
        symbolCount: totalSymbols,
        totalLines,
      },
      workspace,
    });
  } catch (err) {
    console.error('[skeleton] GET error:', err);
    return NextResponse.json(
      { error: 'Failed to load skeleton map' },
      { status: 500 },
    );
  }
}
