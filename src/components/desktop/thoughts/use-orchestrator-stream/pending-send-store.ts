export const ORCHESTRATOR_PENDING_SEND_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const ORCHESTRATOR_PENDING_SEND_STALE_MS = 30_000;

const STORAGE_PREFIX = 'o8:orchestrator-pending-send:v1:';

export interface PersistedOrchestratorPendingSend {
  text: string;
  displayMessage: string;
  threadId: string;
  clientMessageId: string;
  sentAtMs: number;
  /** Exact initial wire payload, so retry preserves backend/model/mode fields. */
  wirePayload?: string;
}

export interface PendingSendStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): PendingSendStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function storageKey(threadId: string, clientMessageId: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(threadId)}:${encodeURIComponent(clientMessageId)}`;
}

function parsePendingSend(value: string | null): PersistedOrchestratorPendingSend | null {
  if (!value) return null;
  try {
    const record = JSON.parse(value) as Partial<PersistedOrchestratorPendingSend>;
    if (
      typeof record.text !== 'string'
      || typeof record.displayMessage !== 'string'
      || typeof record.threadId !== 'string'
      || typeof record.clientMessageId !== 'string'
      || typeof record.sentAtMs !== 'number'
      || !Number.isFinite(record.sentAtMs)
      || (record.wirePayload !== undefined && typeof record.wirePayload !== 'string')
    ) return null;
    return record as PersistedOrchestratorPendingSend;
  } catch {
    return null;
  }
}

export function persistOrchestratorPendingSend(
  record: PersistedOrchestratorPendingSend,
  storage: PendingSendStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(storageKey(record.threadId, record.clientMessageId), JSON.stringify(record));
  } catch {
    // Large attachment payloads can exceed localStorage quota. Preserve the
    // required retry identity/text contract even if the exact wire payload
    // cannot fit; a retry can reconstruct the minimal send from these fields.
    if (!record.wirePayload) return;
    try {
      const boundedRecord = { ...record };
      delete boundedRecord.wirePayload;
      storage.setItem(storageKey(record.threadId, record.clientMessageId), JSON.stringify(boundedRecord));
    } catch {
      // A storage failure must not block the live send path.
    }
  }
}

export function settlePersistedOrchestratorPendingSend(
  threadId: string,
  clientMessageId: string,
  storage: PendingSendStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.removeItem(storageKey(threadId, clientMessageId));
  } catch {
    // Best-effort cleanup; a stale record expires after the server's 24h window.
  }
}

export function listPersistedOrchestratorPendingSends(
  threadId: string,
  storage: PendingSendStorage | null = defaultStorage(),
  nowMs = Date.now(),
): PersistedOrchestratorPendingSend[] {
  if (!storage) return [];
  const records: PersistedOrchestratorPendingSend[] = [];
  try {
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
      .filter((key): key is string => typeof key === 'string' && key.startsWith(STORAGE_PREFIX));
    for (const key of keys) {
      const record = parsePendingSend(storage.getItem(key));
      if (!record || nowMs - record.sentAtMs > ORCHESTRATOR_PENDING_SEND_MAX_AGE_MS) {
        storage.removeItem(key);
        continue;
      }
      if (record.threadId === threadId) records.push(record);
    }
  } catch {
    return [];
  }
  return records.sort((left, right) => left.sentAtMs - right.sentAtMs);
}

export function readPersistedOrchestratorPendingSend(
  threadId: string,
  clientMessageId: string,
  storage: PendingSendStorage | null = defaultStorage(),
): PersistedOrchestratorPendingSend | null {
  if (!storage) return null;
  try {
    return parsePendingSend(storage.getItem(storageKey(threadId, clientMessageId)));
  } catch {
    return null;
  }
}
