import type { ComposerQueuePayload } from '@/lib/orchestrator/composer-queue-types';

export function composerQueuePayloadMatches(left: ComposerQueuePayload, right: ComposerQueuePayload) {
  const stable = (value: unknown) => JSON.stringify(value, (_key, entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  });
  return stable(left) === stable(right);
}
