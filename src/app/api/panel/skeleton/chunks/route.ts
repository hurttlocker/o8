export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getChunksForFile, getChunksForRepo, getChunkStats } from '@/lib/skeleton/store';

const DEFAULT_ROOT = process.env.CORTEX_IDE_REVIEW_REPO_ROOT || '/Users/marquisehurtt/clawd/repos/cortex-ide';

/**
 * GET /api/panel/skeleton/chunks?workspace=<path>&file=<relative>&kind=<symbolKind>
 *
 * Query structural code chunks. The embedding queue (#244) will call this.
 *
 * Modes:
 * - No params → chunk stats for the workspace
 * - file=<path> → chunks for a specific file
 * - kind=<function|class|...> → filter by symbol kind
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const workspace = searchParams.get('workspace') || DEFAULT_ROOT;
  const file = searchParams.get('file');
  const kind = searchParams.get('kind');

  try {
    // Single file mode
    if (file) {
      const chunks = getChunksForFile(workspace, file);
      const filtered = kind ? chunks.filter(c => c.symbolKind === kind) : chunks;
      return NextResponse.json({
        file,
        chunks: filtered,
        count: filtered.length,
        totalTokens: filtered.reduce((sum, c) => sum + c.tokenCount, 0),
        workspace,
      });
    }

    // Repo-wide: return stats + optionally all chunks
    const includeBody = searchParams.get('body') === 'true';

    if (includeBody) {
      const allFiles = getChunksForRepo(workspace);
      const filtered = kind
        ? allFiles.map(f => ({ ...f, chunks: f.chunks.filter(c => c.symbolKind === kind) })).filter(f => f.chunks.length > 0)
        : allFiles;
      return NextResponse.json({
        files: filtered,
        fileCount: filtered.length,
        chunkCount: filtered.reduce((sum, f) => sum + f.chunks.length, 0),
        totalTokens: filtered.reduce((sum, f) => sum + f.totalTokens, 0),
        workspace,
      });
    }

    // Stats only (default — lightweight)
    const stats = getChunkStats(workspace);
    return NextResponse.json({ ...stats, workspace });
  } catch (err) {
    console.error('[skeleton] Chunks GET error:', err);
    return NextResponse.json({ error: 'Failed to load chunks' }, { status: 500 });
  }
}
