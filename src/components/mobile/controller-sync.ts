/**
 * controller-sync.ts — Data fetching: sync, inbox, history, review packets, review files
 */
import type {
  Dispatch,
  SetStateAction,
} from 'react';
import type { RuntimeReviewPacket } from '@/lib/fleet/types';
import type {
  MobileHistoryResponse,
  MobileInboxSnapshot,
  MobileReviewFileResponse,
  MobileRuntimeTailGroup,
  MobileTranscriptEntry,
} from '@/lib/mobile/types';
import { readJson } from './utils';

// ── Consolidated sync ──

interface SyncRequest {
  inbox?: { etag?: string };
  history?: { sessionKey: string; sinceId?: string; limit?: number };
  review?: { sessionKey?: string; includeFile?: string };
  linked?: { sessionKey: string; sinceId?: string };
}

interface SyncResponse {
  inbox?: MobileInboxSnapshot | null;
  inboxEtag?: string;
  history?: { sessionKey: string; entries: MobileTranscriptEntry[] };
  review?: { file?: MobileReviewFileResponse['file'] };
  linked?: { sessionKey: string; entries: MobileTranscriptEntry[] };
  serverTime: string;
  errors?: Record<string, string>;
}

let cachedInboxEtag: string | undefined;

interface MobileSyncArgs {
  wantInbox: boolean;
  historySessionKey?: string;
  historyLastId?: string;
  reviewFilePath?: string;
  linkedSessionKey?: string;
  linkedLastId?: string;
  setSnapshot: Dispatch<SetStateAction<MobileInboxSnapshot>>;
  setRefreshError: Dispatch<SetStateAction<string | null>>;
  setHistoryBySession: Dispatch<SetStateAction<Record<string, MobileTranscriptEntry[]>>>;
  setHistoryGroupsBySession: Dispatch<SetStateAction<Record<string, MobileRuntimeTailGroup[]>>>;
  setReviewFileByPath: Dispatch<SetStateAction<Record<string, MobileReviewFileResponse['file']>>>;
}

export async function mobileSyncOnce({
  wantInbox,
  historySessionKey,
  historyLastId,
  reviewFilePath,
  linkedSessionKey,
  linkedLastId,
  setSnapshot,
  setRefreshError,
  setHistoryBySession,
  setHistoryGroupsBySession,
  setReviewFileByPath,
}: MobileSyncArgs): Promise<SyncResponse | null> {
  const body: SyncRequest = {};
  if (wantInbox) body.inbox = { etag: cachedInboxEtag };
  if (historySessionKey) body.history = { sessionKey: historySessionKey, sinceId: historyLastId, limit: 18 };
  if (reviewFilePath) body.review = { includeFile: reviewFilePath };
  if (linkedSessionKey) body.linked = { sessionKey: linkedSessionKey, sinceId: linkedLastId };

  if (!body.inbox && !body.history && !body.review && !body.linked) return null;

  try {
    const response = await fetch('/api/mobile/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`sync HTTP ${response.status}`);
    const data = (await response.json()) as SyncResponse;

    if (data.inboxEtag) cachedInboxEtag = data.inboxEtag;
    if (data.inbox) {
      setSnapshot((prev) => {
        const prevKey = prev.sessions.map((s) => `${s.sessionKey}:${s.status}:${Math.round(s.context?.usedPercent ?? 0)}`).join('|');
        const nextKey = data.inbox!.sessions.map((s) => `${s.sessionKey}:${s.status}:${Math.round(s.context?.usedPercent ?? 0)}`).join('|');
        if (prevKey === nextKey && prev.summary.alerts === data.inbox!.summary.alerts) return prev;
        return data.inbox!;
      });
      setRefreshError(null);
    }

    if (data.history && data.history.entries.length > 0) {
      const sk = data.history.sessionKey;
      const newEntries = data.history.entries;
      setHistoryBySession((current) => {
        const prev = current[sk] ?? [];
        if (prev.length === 0) return { ...current, [sk]: newEntries };

        // Deduplicate by timestamp+role (stable across index shifts).
        // IDs based on array index are unstable — the same message gets
        // a different ID when the server window slides forward.
        const existingKeys = new Set(
          prev.map((e) => `${e.timestamp ?? 0}:${e.role}:${(e.text ?? '').slice(0, 60)}`),
        );
        const genuinelyNew = newEntries.filter(
          (e) => !existingKeys.has(`${e.timestamp ?? 0}:${e.role}:${(e.text ?? '').slice(0, 60)}`),
        );
        if (genuinelyNew.length === 0) return current;

        // Append new entries and sort by timestamp to maintain order
        const merged = [...prev, ...genuinelyNew];
        merged.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
        return { ...current, [sk]: merged };
      });
    }

    if (data.review?.file && reviewFilePath) {
      setReviewFileByPath((current) => ({ ...current, [reviewFilePath]: data.review!.file as MobileReviewFileResponse['file'] }));
    }

    if (data.linked && data.linked.entries.length > 0 && linkedSessionKey) {
      const sk = data.linked.sessionKey;
      const newEntries = data.linked.entries;
      setHistoryBySession((current) => {
        const prev = current[sk] ?? [];
        if (prev.length === 0) return { ...current, [sk]: newEntries };

        const existingKeys = new Set(
          prev.map((e) => `${e.timestamp ?? 0}:${e.role}:${(e.text ?? '').slice(0, 60)}`),
        );
        const genuinelyNew = newEntries.filter(
          (e) => !existingKeys.has(`${e.timestamp ?? 0}:${e.role}:${(e.text ?? '').slice(0, 60)}`),
        );
        if (genuinelyNew.length === 0) return current;

        const merged = [...prev, ...genuinelyNew];
        merged.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
        return { ...current, [sk]: merged };
      });
    }

    return data;
  } catch (error) {
    if (wantInbox) {
      setRefreshError(error instanceof Error ? error.message : 'sync failed');
    }
    return null;
  }
}

interface RefreshInboxArgs {
  setSnapshot: Dispatch<SetStateAction<MobileInboxSnapshot>>;
  setRefreshError: Dispatch<SetStateAction<string | null>>;
}

export async function refreshInboxSnapshot({
  setSnapshot,
  setRefreshError,
}: RefreshInboxArgs) {
  const response = await fetch(`/api/mobile/inbox?_t=${Date.now()}`, {
    cache: 'no-store',
    headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const nextSnapshot = (await response.json()) as MobileInboxSnapshot;
  setSnapshot((prev) => {
    const prevKey = prev.sessions.map((session) => `${session.sessionKey}:${session.status}:${Math.round(session.context?.usedPercent ?? 0)}`).join('|');
    const nextKey = nextSnapshot.sessions.map((session) => `${session.sessionKey}:${session.status}:${Math.round(session.context?.usedPercent ?? 0)}`).join('|');
    if (prevKey === nextKey && prev.summary.alerts === nextSnapshot.summary.alerts) {
      return prev;
    }
    return nextSnapshot;
  });
  setRefreshError(null);
  return nextSnapshot;
}

interface LoadHistoryArgs {
  sessionKey: string;
  force?: boolean;
  historyBySession: Record<string, MobileTranscriptEntry[]>;
  setHistoryLoading: Dispatch<SetStateAction<Record<string, boolean>>>;
  setHistoryBySession: Dispatch<SetStateAction<Record<string, MobileTranscriptEntry[]>>>;
  setHistoryGroupsBySession: Dispatch<SetStateAction<Record<string, MobileRuntimeTailGroup[]>>>;
  setHistoryError: Dispatch<SetStateAction<Record<string, string | null>>>;
}

export async function loadSessionHistory({
  sessionKey,
  force = false,
  historyBySession,
  setHistoryLoading,
  setHistoryBySession,
  setHistoryGroupsBySession,
  setHistoryError,
}: LoadHistoryArgs) {
  if (!force && historyBySession[sessionKey]?.length) {
    return historyBySession[sessionKey];
  }

  setHistoryLoading((current) => ({ ...current, [sessionKey]: true }));
  try {
    const response = await fetch(`/api/mobile/history?sessionKey=${encodeURIComponent(sessionKey)}&limit=18&_t=${Date.now()}`, {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
    });
    const payload = await readJson<MobileHistoryResponse>(response);
    setHistoryBySession((current) => {
      const prev = current[sessionKey] ?? [];
      const next = payload.transcript;

      // No existing entries — accept full transcript
      if (prev.length === 0) {
        return { ...current, [sessionKey]: next };
      }

      // Deduplicate by timestamp+role+text prefix (stable across index shifts)
      const existingKeys = new Set(
        prev.filter((e) => !e.id.startsWith('optimistic-'))
          .map((e) => `${e.timestamp ?? 0}:${e.role}:${(e.text ?? '').slice(0, 60)}`),
      );
      const genuinelyNew = next.filter(
        (e) => !existingKeys.has(`${e.timestamp ?? 0}:${e.role}:${(e.text ?? '').slice(0, 60)}`),
      );

      if (genuinelyNew.length === 0) return current;

      // Remove optimistic entries that now have real server equivalents
      const realTimestamps = new Set(next.map((e) => e.timestamp).filter(Boolean));
      const withoutStaleOptimistic = prev.filter(
        (e) => !e.id.startsWith('optimistic-') || !realTimestamps.has(e.timestamp),
      );

      const merged = [...withoutStaleOptimistic, ...genuinelyNew];
      merged.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
      return { ...current, [sessionKey]: merged };
    });
    setHistoryGroupsBySession((current) => {
      const prev = current[sessionKey] ?? [];
      const next = payload.groups ?? [];
      if (prev.length === next.length && prev.length > 0 && prev[prev.length - 1]?.id === next[next.length - 1]?.id) {
        return current;
      }
      return { ...current, [sessionKey]: next };
    });
    setHistoryError((current) => ({ ...current, [sessionKey]: null }));
    return payload.transcript;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load session history';
    setHistoryError((current) => ({ ...current, [sessionKey]: message }));
    throw error;
  } finally {
    setHistoryLoading((current) => ({ ...current, [sessionKey]: false }));
  }
}

interface LoadOwnedPacketArgs {
  sessionKey: string;
  force?: boolean;
  reviewPacketBySession: Record<string, RuntimeReviewPacket>;
  setReviewPacketLoadingBySession: Dispatch<SetStateAction<Record<string, boolean>>>;
  setReviewPacketBySession: Dispatch<SetStateAction<Record<string, RuntimeReviewPacket>>>;
  setReviewPacketErrorBySession: Dispatch<SetStateAction<Record<string, string | null>>>;
}

export async function loadOwnedReviewPacketForSession({
  sessionKey,
  force = false,
  reviewPacketBySession,
  setReviewPacketLoadingBySession,
  setReviewPacketBySession,
  setReviewPacketErrorBySession,
}: LoadOwnedPacketArgs) {
  if (!sessionKey.startsWith('codex-owned:')) {
    return null;
  }
  if (!force && reviewPacketBySession[sessionKey]) {
    return reviewPacketBySession[sessionKey];
  }

  setReviewPacketLoadingBySession((current) => ({ ...current, [sessionKey]: true }));
  try {
    const response = await fetch(`/api/runtime/review?surfaceId=${encodeURIComponent(sessionKey)}`, { cache: 'no-store' });
    const payload = await readJson<RuntimeReviewPacket>(response);
    setReviewPacketBySession((current) => ({ ...current, [sessionKey]: payload }));
    setReviewPacketErrorBySession((current) => ({ ...current, [sessionKey]: null }));
    return payload;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load the owned review packet.';
    setReviewPacketErrorBySession((current) => ({ ...current, [sessionKey]: message }));
    throw error;
  } finally {
    setReviewPacketLoadingBySession((current) => ({ ...current, [sessionKey]: false }));
  }
}

interface LoadReviewFileArgs {
  reviewPath: string;
  force?: boolean;
  reviewFileByPath: Record<string, MobileReviewFileResponse['file']>;
  setReviewFileLoadingPath: Dispatch<SetStateAction<string | null>>;
  setReviewFileError: Dispatch<SetStateAction<string | null>>;
  setReviewFileByPath: Dispatch<SetStateAction<Record<string, MobileReviewFileResponse['file']>>>;
}

export async function loadReviewFilePreview({
  reviewPath,
  force = false,
  reviewFileByPath,
  setReviewFileLoadingPath,
  setReviewFileError,
  setReviewFileByPath,
}: LoadReviewFileArgs) {
  if (!force && reviewFileByPath[reviewPath]) {
    setReviewFileError(null);
    return reviewFileByPath[reviewPath];
  }

  setReviewFileLoadingPath(reviewPath);
  setReviewFileError(null);
  try {
    const response = await fetch(`/api/mobile/review-file?path=${encodeURIComponent(reviewPath)}`, { cache: 'no-store' });
    const payload = await readJson<MobileReviewFileResponse>(response);
    setReviewFileByPath((current) => ({ ...current, [reviewPath]: payload.file }));
    return payload.file;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load the per-file review preview.';
    setReviewFileError(message);
    throw error;
  } finally {
    setReviewFileLoadingPath((current) => (current === reviewPath ? null : current));
  }
}
