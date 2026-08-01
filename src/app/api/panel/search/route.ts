/** Cmd+K grouped fan-out search for issue #984 Stage 1. */

export const dynamic = 'force-dynamic';

import { performance } from 'node:perf_hooks';
import { NextResponse } from 'next/server';
import { searchAgents } from '@/lib/search/agents';
import { searchApprovals } from '@/lib/search/approvals';
import { searchConversations } from '@/lib/search/conversations';
import { searchDirectives } from '@/lib/search/directives';
import { searchFiles } from '@/lib/search/files';
import { searchInbox } from '@/lib/search/inbox';
import { browseIssues, searchIssues } from '@/lib/search/issues';
import { searchTranscripts } from '@/lib/search/transcripts';
import {
  emptySearchGroups,
  type SearchGroups,
  type SearchKind,
  type SearchResponse,
  type SearchResult,
} from '@/lib/search/types';

const SEARCH_DEADLINE_MS = 1_500;
const RESULT_CAP = 8;

function isBrowseKind(value: string | null): value is SearchKind {
  return value === 'agent'
    || value === 'chat'
    || value === 'directive'
    || value === 'issue'
    || value === 'file';
}

function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`provider timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function GET(request: Request): Promise<NextResponse<SearchResponse>> {
  let query = '';
  const emptyGroups = emptySearchGroups();
  try {
    const { searchParams } = new URL(request.url);
    query = (searchParams.get('q') ?? '').trim();
    const workspace = searchParams.get('workspace');
    const repoParam = searchParams.get('repo');
    const scopeParam = searchParams.get('scope');

    if (query.length < 2) {
      const browseKind = isBrowseKind(scopeParam) ? scopeParam : null;
      if (!browseKind) return NextResponse.json({ query, results: [], groups: emptyGroups });
      const browseResults = browseKind === 'agent'
        ? await searchAgents('', true)
        : browseKind === 'chat'
          ? await searchConversations('', true)
          : browseKind === 'directive'
            ? searchDirectives('', true)
            : browseKind === 'issue'
              ? await browseIssues(repoParam)
              : [];
      return NextResponse.json({
        query,
        results: browseResults,
        groups: { ...emptyGroups, [browseKind]: browseResults },
      });
    }

    const providers: Array<{ kind: SearchKind; run: () => Promise<SearchResult[]> }> = [
      { kind: 'issue', run: () => searchIssues(query, repoParam) },
      { kind: 'file', run: () => searchFiles(query, workspace) },
      { kind: 'agent', run: () => searchAgents(query) },
      { kind: 'chat', run: () => searchConversations(query) },
      { kind: 'transcript', run: () => searchTranscripts(query) },
      { kind: 'approval', run: () => searchApprovals(query) },
      { kind: 'inbox', run: () => searchInbox(query) },
      { kind: 'directive', run: () => Promise.resolve(searchDirectives(query)) },
    ];
    const timings: Partial<Record<SearchKind, number>> = {};
    const settled = await Promise.allSettled(
      providers.map(async (provider) => {
        const startedAt = performance.now();
        try {
          return await withDeadline(provider.run(), SEARCH_DEADLINE_MS);
        } finally {
          timings[provider.kind] = Number((performance.now() - startedAt).toFixed(1));
        }
      }),
    );
    const groups: SearchGroups = emptySearchGroups();
    const providerErrors: Partial<Record<SearchKind, string>> = {};
    for (let index = 0; index < providers.length; index += 1) {
      const provider = providers[index];
      const result = settled[index];
      if (result?.status === 'fulfilled') {
        groups[provider.kind] = result.value
          .sort((left, right) => right.score - left.score)
          .slice(0, RESULT_CAP);
      } else {
        providerErrors[provider.kind] = result?.reason instanceof Error
          ? result.reason.message
          : 'provider failed';
      }
    }
    const results = Object.values(groups).flat().sort((left, right) => right.score - left.score);
    return NextResponse.json({
      query,
      results,
      groups,
      timings,
      ...(Object.keys(providerErrors).length > 0 ? { providerErrors } : {}),
    });
  } catch (error) {
    return NextResponse.json(
      {
        query,
        results: [],
        groups: emptyGroups,
        error: error instanceof Error ? error.message : 'Search failed',
      },
      { status: 500 },
    );
  }
}
