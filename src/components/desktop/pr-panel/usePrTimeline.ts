'use client';

import { useMemo } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { issueListQuery } from '@/lib/github-client';
import type { PrTimelineEvent, PrTimelinePage } from './types';
import { readPrJson } from './read-pr-json';
import { prTimelineQueryKey } from './timeline-query-key';

function validEvent(value: unknown): value is PrTimelineEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<PrTimelineEvent>;
  return typeof event.id === 'string' && Boolean(event.id)
    && typeof event.kind === 'string' && typeof event.title === 'string'
    && typeof event.actor === 'string' && typeof event.at === 'string'
    && typeof event.body === 'string' && typeof event.url === 'string'
    && (event.avatarUrl === null || typeof event.avatarUrl === 'string')
    && (event.commitSha === undefined || typeof event.commitSha === 'string');
}

export function usePrTimeline(number: number, repo: string | null | undefined, active: boolean) {
  const slug = repo?.trim() || null;
  const query = useInfiniteQuery({
    ...issueListQuery(slug ?? ''),
    // Timeline pages have a separate shape from repository issue/PR lists.
    queryKey: prTimelineQueryKey(slug, number),
    initialPageParam: 1,
    queryFn: async ({ pageParam, signal }): Promise<PrTimelinePage> => {
      const search = new URLSearchParams({ page: String(pageParam) });
      if (slug) search.set('repo', slug);
      const result = await readPrJson<PrTimelinePage & { error?: string }>(`/api/panel/prs/${number}/timeline?${search}`, signal);
      if (!result || result.error || !Array.isArray(result.events) || !result.events.every(validEvent)
        || !(result.nextPage === null || (Number.isSafeInteger(result.nextPage) && result.nextPage > pageParam))) {
        throw new Error('Activity could not be loaded. Retry.');
      }
      return result;
    },
    getNextPageParam: (lastPage) => lastPage.nextPage ?? undefined,
    enabled: active,
    // Opening and explicit Refresh/Retry are the timeline's existing triggers.
    refetchInterval: false,
    retry: false,
  });
  const data = useMemo(() => {
    if (!query.data) return null;
    const events = new Map(query.data.pages.flatMap(page => page.events).map(event => [event.id, event]));
    return { events: [...events.values()], nextPage: query.data.pages.at(-1)?.nextPage ?? null };
  }, [query.data]);

  return {
    data,
    loadedAt: query.dataUpdatedAt,
    loading: query.isFetching || Boolean(active && query.isPending),
    error: query.error?.message ?? null,
    refresh: () => query.refetch(),
    retry: () => query.isFetchNextPageError ? query.fetchNextPage() : query.refetch(),
    loadMore: () => query.hasNextPage ? query.fetchNextPage() : Promise.resolve(),
  };
}
