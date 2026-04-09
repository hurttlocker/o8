export const dynamic = 'force-dynamic';

/**
 * Cortex Injection Preview — shows exactly what directives + ledger content
 * will be injected into the next agent session for a given repo.
 *
 * This is the observability surface: dogfooding's moment of truth.
 */

import { NextResponse } from 'next/server';
import { buildDirectiveBlock } from '@/lib/cortex/directives-store';
import { buildLedgerBlock } from '@/lib/cortex/ledger';

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const repoName = url.searchParams.get('repoName');
    const repoPath = url.searchParams.get('repoPath') ?? '';

    const directives = buildDirectiveBlock(repoName);
    const ledger = buildLedgerBlock(repoPath);

    const combined = [directives.text, ledger.text].filter(Boolean).join('\n\n');
    const totalTokens = directives.tokenEstimate + ledger.tokenEstimate;

    return NextResponse.json({
      repoName,
      repoPath,
      directives: {
        text: directives.text,
        tokenEstimate: directives.tokenEstimate,
        count: directives.directiveCount,
      },
      ledger: {
        text: ledger.text,
        tokenEstimate: ledger.tokenEstimate,
        count: ledger.outcomeCount,
      },
      combined,
      totalTokens,
    });
  } catch (error) {
    console.error('[cortex/preview] error:', error);
    return NextResponse.json({ error: 'Failed to build preview' }, { status: 500 });
  }
}
