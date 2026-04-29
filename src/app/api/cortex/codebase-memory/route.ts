/**
 * GET /api/cortex/codebase-memory
 *
 * Returns the live state of the codebase-memory boot indexer (#741, epic
 * #738 Context Engine v2). The status-bar pill in #742's Recall card UI
 * polls this to render the "Indexing 2/4 repos…" chip and to know when
 * the index is ready for dispatch.
 *
 * Side-effect: also kicks the boot pass if it hasn't fired yet — the
 * regular hook is /api/panel/status but the UI may render before that
 * route gets hit, so we double-trigger here. Both are idempotent.
 *
 * Response shape: see IndexState in src/lib/codebase-memory/types.ts.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import {
  ensureCodebaseMemoryBootIndex,
  getIndexState,
} from '@/lib/codebase-memory/indexer';

export async function GET() {
  ensureCodebaseMemoryBootIndex();
  const state = getIndexState();
  return NextResponse.json(state);
}
