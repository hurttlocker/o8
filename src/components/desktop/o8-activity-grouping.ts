import type { ActivityCommitItem, ActivityItem, EventEntry } from './agent-panel/types';

const SHA_PATTERN = /\b[0-9a-f]{7,40}\b/i;

function normalizeSha(value: string | null | undefined): string | null {
  const matches = value?.match(new RegExp(SHA_PATTERN, 'ig')) ?? [];
  const match = matches.sort((a, b) => b.length - a.length)[0];
  return match ? match.toLowerCase() : null;
}

function eventSha(event: EventEntry): string | null {
  const haystack = [event.title, event.detail, event.subLabel].filter(Boolean).join(' ');
  if (!/\b(push|pushed|commit|sha)\b/i.test(haystack)) return null;
  return normalizeSha(haystack);
}

function itemSha(item: ActivityItem): string | null {
  if (item.kind === 'commit') return normalizeSha(item.hash);
  if (item.kind === 'ci') return normalizeSha(item.headSha);
  if (item.kind === 'event') return eventSha(item.data);
  return null;
}

function isPushEvent(item: ActivityItem): item is Extract<ActivityItem, { kind: 'event' }> {
  return item.kind === 'event' && /\b(push|pushed|git push)\b/i.test(`${item.data.title} ${item.data.detail}`);
}

export function groupActivityByCommitSha(items: ActivityItem[]): ActivityItem[] {
  const groups = new Map<string, { commit: ActivityCommitItem; maxTs: number }>();
  const output: ActivityItem[] = [];

  for (const item of items) {
    if (item.kind !== 'commit') continue;
    const sha = itemSha(item);
    if (!sha || groups.has(sha)) continue;
    const commit = { ...item };
    groups.set(sha, { commit, maxTs: item.ts });
    output.push(commit);
  }

  for (const item of items) {
    if (item.kind === 'commit') continue;
    const sha = itemSha(item);
    const group = sha ? groups.get(sha) : null;
    if (!group) {
      output.push(item);
      continue;
    }
    group.maxTs = Math.max(group.maxTs, item.ts);
    group.commit.ts = group.maxTs;
    if (item.kind === 'ci') {
      group.commit.groupedCiRun = item;
    } else if (isPushEvent(item)) {
      group.commit.groupedPushEvent = item.data;
    } else {
      output.push(item);
    }
  }

  return output.sort((a, b) => {
    const aSha = itemSha(a);
    const bSha = itemSha(b);
    const aTs = aSha && groups.has(aSha) ? groups.get(aSha)!.maxTs : a.ts;
    const bTs = bSha && groups.has(bSha) ? groups.get(bSha)!.maxTs : b.ts;
    return bTs - aTs;
  });
}
