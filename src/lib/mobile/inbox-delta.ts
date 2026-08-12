import type { MobileInboxSnapshot } from '@/lib/mobile/types';
import type { RealtimeRevision } from '@/lib/realtime/generated-contract';
export { MOBILE_INBOX_DELTA_CAPABILITY } from '@/lib/realtime/generated-contract';

type InboxCollectionKey =
  | 'sessions'
  | 'fleetSessions'
  | 'approvals'
  | 'reviewUnits'
  | 'items';

type InboxEntity = { id: string };

export interface MobileInboxEntityDelta<T extends InboxEntity> {
  upserts: T[];
  removals: string[];
  /** Authoritative presentation order after applying this revision. */
  order: string[];
}

export interface MobileInboxDelta extends RealtimeRevision {
  protocol: 1;
  baseRevision: number;
  revision: number;
  generatedAt: string;
  mode: MobileInboxSnapshot['mode'];
  sourceLabel: string;
  primarySessionKey?: string;
  note?: string;
  summary: MobileInboxSnapshot['summary'];
  review?: MobileInboxSnapshot['review'];
  entities: {
    sessions: MobileInboxEntityDelta<MobileInboxSnapshot['sessions'][number]>;
    fleetSessions: MobileInboxEntityDelta<MobileInboxSnapshot['fleetSessions'][number]>;
    approvals: MobileInboxEntityDelta<MobileInboxSnapshot['approvals'][number]>;
    reviewUnits: MobileInboxEntityDelta<MobileInboxSnapshot['reviewUnits'][number]>;
    items: MobileInboxEntityDelta<MobileInboxSnapshot['items'][number]>;
  };
}

function sameEntity(left: InboxEntity, right: InboxEntity): boolean {
  if (left === right) return true;
  return JSON.stringify(left) === JSON.stringify(right);
}

function diffCollection<T extends InboxEntity>(
  previous: T[],
  next: T[],
): MobileInboxEntityDelta<T> {
  const previousById = new Map(previous.map((entity) => [entity.id, entity]));
  const nextIds = new Set<string>();
  const upserts: T[] = [];

  for (const entity of next) {
    nextIds.add(entity.id);
    const old = previousById.get(entity.id);
    if (!old || !sameEntity(old, entity)) upserts.push(entity);
  }

  return {
    upserts,
    removals: previous
      .filter((entity) => !nextIds.has(entity.id))
      .map((entity) => entity.id),
    order: next.map((entity) => entity.id),
  };
}

/** Build a revision-bound structural delta between two canonical checkpoints. */
export function buildMobileInboxDelta(
  previous: MobileInboxSnapshot,
  next: MobileInboxSnapshot,
  baseRevision: number,
  revision: number,
): MobileInboxDelta {
  return {
    protocol: 1,
    baseRevision,
    revision,
    generatedAt: next.generatedAt,
    mode: next.mode,
    sourceLabel: next.sourceLabel,
    ...(next.primarySessionKey
      ? { primarySessionKey: next.primarySessionKey }
      : {}),
    ...(next.note ? { note: next.note } : {}),
    summary: next.summary,
    ...(next.review ? { review: next.review } : {}),
    entities: {
      sessions: diffCollection(previous.sessions, next.sessions),
      fleetSessions: diffCollection(
        previous.fleetSessions ?? [],
        next.fleetSessions ?? [],
      ),
      approvals: diffCollection(previous.approvals, next.approvals),
      reviewUnits: diffCollection(
        previous.reviewUnits ?? [],
        next.reviewUnits ?? [],
      ),
      items: diffCollection(previous.items, next.items),
    },
  };
}

export function mobileInboxDeltaChangedEntityCount(
  delta: MobileInboxDelta,
): number {
  const keys: InboxCollectionKey[] = [
    'sessions',
    'fleetSessions',
    'approvals',
    'reviewUnits',
    'items',
  ];
  return keys.reduce((count, key) => {
    const entityDelta = delta.entities[key];
    return count + entityDelta.upserts.length + entityDelta.removals.length;
  }, 0);
}
