import type {
  BrowserRealtimeSnapshotPayload,
  MobileInboxRealtimeSnapshotPayload,
  RealtimeEntityState,
  RealtimeEventEnvelope,
  RealtimeMutationRecord,
  ReviewRealtimeSnapshotPayload,
  RuntimeRealtimeSnapshotPayload,
  SessionHistoryRealtimePayload,
} from '@/lib/realtime/types';

const SETTLED_MUTATION_TTL_MS = 30_000;

function healthRank(state: RealtimeEntityState['connection']['realtimeState']) {
  switch (state) {
    case 'degraded':
      return 3;
    case 'stale':
      return 2;
    case 'warming':
      return 1;
    case 'live':
    default:
      return 0;
  }
}

function deriveOverallHealth(healthByChannel: RealtimeEntityState['connection']['healthByChannel']) {
  const values = Object.values(healthByChannel);
  if (!values.length) return 'warming' as const;
  let worst: RealtimeEntityState['connection']['realtimeState'] = 'live';
  for (const value of values) {
    if (healthRank(value.state) > healthRank(worst)) {
      worst = value.state;
    }
  }
  return worst;
}

function entityKeyForEnvelope(envelope: RealtimeEventEnvelope) {
  switch (envelope.event) {
    case 'runtime.snapshot':
      return 'runtime:fleet';
    case 'review.snapshot':
      return `review:${envelope.entityId ?? 'workflow-review'}`;
    case 'browser.snapshot':
      return `browser:${envelope.entityId ?? 'browser-inventory'}`;
    case 'mobile.inbox.snapshot':
      return `mobile:${envelope.entityId ?? 'mobile-inbox'}`;
    case 'history.snapshot': {
      const payload = envelope.data as SessionHistoryRealtimePayload;
      return `history:${payload.sessionKey}`;
    }
    case 'mutation.record':
    case 'mutation.settled': {
      const mutation = (envelope.data as { mutation: RealtimeMutationRecord }).mutation;
      return `mutation:${mutation.mutationId}`;
    }
    default:
      return `${envelope.channel}:${envelope.entityId ?? envelope.stream}`;
  }
}

function normalizeEntries<T extends { id: string; timestamp?: number; role: string; text: string }>(
  existing: T[],
  incoming: T[],
) {
  if (!incoming.length) return existing;

  const existingIds = new Set(existing.map((entry) => entry.id));
  const existingKeys = new Set(
    existing.map((entry) => `${entry.timestamp ?? 0}:${entry.role}:${entry.text.slice(0, 80)}`),
  );

  const additions = incoming.filter((entry) => (
    !existingIds.has(entry.id)
    && !existingKeys.has(`${entry.timestamp ?? 0}:${entry.role}:${entry.text.slice(0, 80)}`)
  ));

  if (!additions.length) return existing;

  const merged = [...existing, ...additions];
  merged.sort((left, right) => (left.timestamp ?? 0) - (right.timestamp ?? 0));
  return merged;
}

function pruneSettledMutations(mutations: Record<string, RealtimeMutationRecord>) {
  const now = Date.now();
  const next: Record<string, RealtimeMutationRecord> = {};

  for (const [mutationId, mutation] of Object.entries(mutations)) {
    if (!mutation.settledAt) {
      next[mutationId] = mutation;
      continue;
    }

    const settledAt = Date.parse(mutation.settledAt);
    if (!Number.isFinite(settledAt) || (now - settledAt) < SETTLED_MUTATION_TTL_MS) {
      next[mutationId] = mutation;
    }
  }

  return next;
}

export function createInitialRealtimeEntityState(
  partial: Partial<RealtimeEntityState> = {},
): RealtimeEntityState {
  return {
    fleet: partial.fleet ?? null,
    review: partial.review ?? null,
    reviewError: partial.reviewError ?? null,
    browserInventory: partial.browserInventory ?? null,
    attachedBrowser: partial.attachedBrowser ?? null,
    browserError: partial.browserError ?? null,
    mobileInbox: partial.mobileInbox ?? null,
    transcripts: partial.transcripts ?? {},
    mutations: partial.mutations ?? {},
    streamSeq: partial.streamSeq ?? {},
    entitySeq: partial.entitySeq ?? {},
    connection: {
      transport: partial.connection?.transport ?? 'connecting',
      realtimeState: partial.connection?.realtimeState ?? 'warming',
      lastEventAt: partial.connection?.lastEventAt,
      healthByChannel: partial.connection?.healthByChannel ?? {},
    },
  };
}

export function reduceRealtimeEvent(
  state: RealtimeEntityState,
  envelope: RealtimeEventEnvelope,
): RealtimeEntityState {
  const entityKey = entityKeyForEnvelope(envelope);
  const lastEntitySeq = state.entitySeq[entityKey] ?? 0;
  if (envelope.capturedSeq != null && lastEntitySeq > envelope.capturedSeq) {
    return state;
  }
  if (envelope.seq <= lastEntitySeq) {
    return state;
  }

  const nextHealthByChannel = envelope.health
    ? {
        ...state.connection.healthByChannel,
        [envelope.channel]: envelope.health,
      }
    : state.connection.healthByChannel;
  const nextState: RealtimeEntityState = {
    ...state,
    streamSeq: {
      ...state.streamSeq,
      [envelope.stream]: Math.max(state.streamSeq[envelope.stream] ?? 0, envelope.seq),
    },
    entitySeq: {
      ...state.entitySeq,
      [entityKey]: envelope.seq,
    },
    connection: {
      ...state.connection,
      lastEventAt: envelope.ts,
      healthByChannel: nextHealthByChannel,
      realtimeState: deriveOverallHealth(nextHealthByChannel),
    },
  };

  switch (envelope.event) {
    case 'runtime.snapshot': {
      const payload = envelope.data as RuntimeRealtimeSnapshotPayload;
      nextState.fleet = payload.fleet;
      return nextState;
    }
    case 'review.snapshot': {
      const payload = envelope.data as ReviewRealtimeSnapshotPayload;
      nextState.review = payload.review;
      nextState.reviewError = payload.error ?? null;
      return nextState;
    }
    case 'browser.snapshot': {
      const payload = envelope.data as BrowserRealtimeSnapshotPayload;
      nextState.browserInventory = payload.browserInventory;
      nextState.attachedBrowser = payload.attachedBrowser ?? null;
      nextState.browserError = payload.error ?? null;
      return nextState;
    }
    case 'mobile.inbox.snapshot': {
      const payload = envelope.data as MobileInboxRealtimeSnapshotPayload;
      nextState.mobileInbox = payload.inbox;
      return nextState;
    }
    case 'history.snapshot': {
      const { sessionKey, entries } = envelope.data as SessionHistoryRealtimePayload;
      nextState.transcripts = {
        ...state.transcripts,
        [sessionKey]: normalizeEntries(state.transcripts[sessionKey] ?? [], entries),
      };
      return nextState;
    }
    case 'mutation.record':
    case 'mutation.settled': {
      const mutation = (envelope.data as { mutation: RealtimeMutationRecord }).mutation;
      nextState.mutations = pruneSettledMutations({
        ...state.mutations,
        [mutation.mutationId]: mutation,
      });
      return nextState;
    }
    default:
      return nextState;
  }
}

export class RealtimeEntityStore {
  private state: RealtimeEntityState;

  private listeners = new Set<() => void>();

  constructor(initialState: Partial<RealtimeEntityState> = {}) {
    this.state = createInitialRealtimeEntityState(initialState);
  }

  getState = () => this.state;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private emit() {
    for (const listener of this.listeners) {
      listener();
    }
  }

  replace(partial: Partial<RealtimeEntityState>) {
    this.state = createInitialRealtimeEntityState({
      ...this.state,
      ...partial,
    });
    this.emit();
  }

  setTransport(transport: RealtimeEntityState['connection']['transport']) {
    if (this.state.connection.transport === transport) return;
    this.state = {
      ...this.state,
      connection: {
        ...this.state.connection,
        transport,
      },
    };
    this.emit();
  }

  applyEnvelope(envelope: RealtimeEventEnvelope) {
    this.state = reduceRealtimeEvent(this.state, envelope);
    this.emit();
  }

  applyBatch(envelopes: RealtimeEventEnvelope[]) {
    if (!envelopes.length) return;
    let next = this.state;
    for (const envelope of envelopes) {
      next = reduceRealtimeEvent(next, envelope);
    }
    this.state = next;
    this.emit();
  }

  beginMutation(mutation: RealtimeMutationRecord) {
    this.state = {
      ...this.state,
      mutations: {
        ...this.state.mutations,
        [mutation.mutationId]: mutation,
      },
    };
    this.emit();
  }

  settleMutation(mutation: RealtimeMutationRecord) {
    this.state = {
      ...this.state,
      mutations: pruneSettledMutations({
        ...this.state.mutations,
        [mutation.mutationId]: mutation,
      }),
    };
    this.emit();
  }
}
