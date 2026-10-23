'use client';

import { useEffect, useState } from 'react';
import { summarizeLaneReviewDiff } from '@/lib/review/lane-diff';

export interface WorkerHandbackData {
  files: number;
  additions: number;
  deletions: number;
  diff?: string;
  prNumber?: number;
}

/** Full diffstat remains authoritative when the patch response is byte-bounded. */
export function handbackFromDiff(payload: { diff?: string; stat?: string; truncated?: boolean }): WorkerHandbackData | null {
  const counts = payload.stat?.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
  if (counts) return { files: Number(counts[1]), additions: Number(counts[2] ?? 0), deletions: Number(counts[3] ?? 0), diff: payload.diff };
  if (payload.truncated) return null;
  const summary = summarizeLaneReviewDiff(payload.diff ?? '');
  return summary.files.length ? { files: summary.files.length, additions: summary.additions, deletions: summary.deletions, diff: payload.diff } : null;
}

export function WorkerHandback({ data, repoPath, onReview }: { data: WorkerHandbackData; repoPath?: string | null; onReview?: () => void }) {
  const [open, setOpen] = useState(false);
  if (data.files <= 0) return null;
  const review = () => {
    if (data.prNumber) window.dispatchEvent(new CustomEvent('o8:open-pr', { detail: { prNumber: data.prNumber, repoPath } }));
    else if (onReview) onReview();
    else setOpen(value => !value);
  };
  return <div data-worker-handback style={{ minWidth: 0, marginTop: 2 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 28 }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', flexWrap: 'wrap', gap: 5, minHeight: 20, paddingLeft: 6, paddingRight: 6, borderRadius: 5,
        background: 'var(--t-hover)', color: 'var(--t-text-muted)', fontSize: 11, fontWeight: 300 }}>
        {data.files} {data.files === 1 ? 'file' : 'files'}
        <span style={{ color: 'var(--t-success)' }}>+{data.additions}</span>
        <span style={{ color: 'var(--t-tone-fail)' }}>−{data.deletions}</span>
      </span>
      <button type="button" onClick={review} aria-expanded={!data.prNumber && !onReview ? open : undefined}
        style={{ marginLeft: 'auto', flexShrink: 0, height: 24, paddingTop: 0, paddingBottom: 0, paddingLeft: 10, paddingRight: 10, border: 0, borderRadius: 8,
          background: 'var(--t-text)', color: 'var(--t-chat-surface-bg)', fontFamily: 'inherit', fontSize: 12, fontWeight: 300, cursor: 'pointer' }}>
        {data.prNumber ? 'Open PR' : 'Review'}
      </button>
    </div>
    {open ? <pre tabIndex={0} aria-label="Packet diff" style={{ marginTop: 8, marginBottom: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 300, overflowY: 'auto', fontSize: 11, color: 'var(--t-text-muted)' }}>{data.diff}</pre> : null}
  </div>;
}

export function PacketWorkerHandback({ laneId, repoPath, finished, revision, onReview }: {
  laneId?: string | null; repoPath?: string | null; finished: boolean; revision: string; onReview?: () => void;
}) {
  const [snapshot, setSnapshot] = useState<{ key: string; data: WorkerHandbackData } | null>(null);
  const key = `${laneId}:${revision}`;
  useEffect(() => {
    if (!finished || !laneId) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/lanes/${encodeURIComponent(laneId)}/diff?maxBytes=524288`, { cache: 'no-store', signal: controller.signal });
        if (!response.ok) return;
        const payload = await response.json() as { ok?: boolean; diff?: string; stat?: string; truncated?: boolean; laneId?: string };
        if (!payload.ok) return;
        const data = handbackFromDiff(payload);
        if (!data || !data.files || controller.signal.aborted) return;
        setSnapshot({ key, data });
        const laneResponse = await fetch(`/api/lanes/${encodeURIComponent(payload.laneId ?? laneId)}?events=0`, { cache: 'no-store', signal: controller.signal });
        if (!laneResponse.ok) return;
        const lanePayload = await laneResponse.json() as { lane?: { prNumber?: number | null } };
        if (!controller.signal.aborted && typeof lanePayload.lane?.prNumber === 'number') {
          setSnapshot({ key, data: { ...data, prNumber: lanePayload.lane.prNumber } });
        }
      } catch { /* A diff without an authoritative readback gets no handback row. */ }
    })();
    return () => controller.abort();
  }, [finished, laneId, key]);
  return finished && snapshot?.key === key ? <WorkerHandback data={snapshot.data} repoPath={repoPath} onReview={onReview} /> : null;
}
