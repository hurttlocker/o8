import { getQueryClient } from '@/lib/query/client';

export function prTimelineQueryKey(repo: string | null | undefined, number: number) {
  return ['gh', repo?.trim().toLowerCase() || null, 'pr-timeline', number] as const;
}

/** A confirmed write must supersede any older read, including an inactive snapshot. */
export function invalidatePrTimeline(repo: string, number: number) {
  const client = getQueryClient();
  const queryKey = prTimelineQueryKey(repo, number);
  void client.cancelQueries({ queryKey, exact: true })
    .then(() => client.invalidateQueries({ queryKey, exact: true }))
    // A refresh failure must not turn confirmed delivery into an uncertain write.
    .catch(() => {});
}
