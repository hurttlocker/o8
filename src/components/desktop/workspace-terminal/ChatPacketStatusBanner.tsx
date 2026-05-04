'use client';

/**
 * ChatPacketStatusBanner — inline status card for the bottom of a
 * dispatched packet's workspace chat thread.
 *
 * Renders when the live packet status moves out of the in-flight zone
 * (awaiting_review / released / failed / recovering) so the operator
 * always sees the next step inline with the transcript, not just in
 * the tab header pill or the O8 Activity tab.
 *
 * Action buttons (Approve & Merge / Create PR) wire directly to
 * /api/lanes — same verbs the Activity tab's full PacketReviewCard
 * uses. The banner is intentionally narrower than that card; for a
 * full review surface (review snapshot, file list, conflict log) the
 * "Open in Activity" link bounces the operator to the wide panel.
 */

import { useCallback, useState } from 'react';
import type { OrchestratorPacketStatus } from '@/lib/orchestrator/types';

interface ChatPacketStatusBannerProps {
  status: OrchestratorPacketStatus | null;
  laneId: string | null;
  packetTitle: string | null;
  onOpenInActivity?: () => void;
}

type Tone = {
  label: string;
  detail: string;
  color: string;
  background: string;
  border: string;
};

const TONE_BY_STATUS: Partial<Record<OrchestratorPacketStatus, Tone>> = {
  awaiting_review: {
    label: 'Ready for review',
    detail: 'Agent finished. Approve to merge into main, or open the diff first.',
    color: '#b45309',
    background: 'rgba(245, 158, 11, 0.1)',
    border: 'rgba(245, 158, 11, 0.28)',
  },
  released: {
    label: 'Merged',
    detail: 'Branch merged into main. The packet is closed.',
    color: '#15803d',
    background: 'rgba(22, 163, 74, 0.1)',
    border: 'rgba(22, 163, 74, 0.28)',
  },
  failed: {
    label: 'Failed',
    detail: 'The agent could not complete this packet. Open the Activity tab to retry or reset.',
    color: '#b91c1c',
    background: 'rgba(239, 68, 68, 0.1)',
    border: 'rgba(239, 68, 68, 0.28)',
  },
  recovering: {
    label: 'Recovering',
    detail: 'The session was lost — re-attaching. No action needed yet.',
    color: '#1d4ed8',
    background: 'rgba(37, 99, 235, 0.08)',
    border: 'rgba(37, 99, 235, 0.24)',
  },
};

export function ChatPacketStatusBanner({
  status,
  laneId,
  packetTitle,
  onOpenInActivity,
}: ChatPacketStatusBannerProps) {
  const tone = status ? TONE_BY_STATUS[status] : undefined;
  const [pending, setPending] = useState<'merge' | 'create_pr' | null>(null);
  const [actionNote, setActionNote] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const callLaneAction = useCallback(async (verb: 'merge' | 'create_pr') => {
    if (!laneId) return;
    setPending(verb);
    setActionError(null);
    setActionNote(null);
    try {
      const response = await fetch('/api/lanes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          verb,
          laneId,
          commitMessage: verb === 'create_pr' ? 'Auto-commit from lane' : `Merge lane: ${packetTitle ?? 'packet'}`,
        }),
      });
      const payload = await response.json().catch(() => null) as { ok?: boolean; note?: string } | null;
      const note = payload?.note ?? (verb === 'create_pr' ? 'Unable to create PR.' : 'Unable to merge.');
      if (!response.ok || !payload?.ok) {
        throw new Error(verb === 'merge' && /conflict/i.test(note) ? `${note} Try Create PR instead.` : note);
      }
      setActionNote(note);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Lane action failed.');
    } finally {
      setPending(null);
    }
  }, [laneId, packetTitle]);

  if (!tone) return null;

  return (
    <div
      style={{
        marginTop: 8,
        marginRight: 14,
        marginLeft: 14,
        paddingTop: 10,
        paddingRight: 12,
        paddingBottom: 10,
        paddingLeft: 12,
        borderRadius: 12,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: tone.border,
        background: tone.background,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <span
          style={{
            paddingTop: 1,
            paddingRight: 7,
            paddingBottom: 1,
            paddingLeft: 7,
            borderRadius: 999,
            background: tone.color,
            color: '#fff',
            fontSize: 9,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            flexShrink: 0,
            marginTop: 1,
          }}
        >
          {tone.label}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: tone.color, letterSpacing: '-0.01em' }}>
            {packetTitle ?? 'Dispatched packet'}
          </div>
          <div style={{ fontSize: 11, color: 'var(--t-text-secondary)', marginTop: 2, lineHeight: 1.45 }}>
            {tone.detail}
          </div>
        </div>
      </div>

      {status === 'awaiting_review' && laneId ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <button
            type="button"
            onClick={() => { void callLaneAction('merge'); }}
            disabled={pending !== null}
            style={{
              paddingTop: 4,
              paddingRight: 10,
              paddingBottom: 4,
              paddingLeft: 10,
              borderRadius: 8,
              borderWidth: 0,
              background: pending === 'merge' ? 'rgba(22, 163, 74, 0.6)' : '#16a34a',
              color: '#fff',
              fontSize: 11,
              fontWeight: 700,
              cursor: pending !== null ? 'wait' : 'pointer',
              fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
              letterSpacing: '-0.005em',
            }}
          >
            {pending === 'merge' ? 'Merging…' : 'Approve & merge'}
          </button>
          <button
            type="button"
            onClick={() => { void callLaneAction('create_pr'); }}
            disabled={pending !== null}
            style={{
              paddingTop: 4,
              paddingRight: 10,
              paddingBottom: 4,
              paddingLeft: 10,
              borderRadius: 8,
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: tone.border,
              background: 'transparent',
              color: tone.color,
              fontSize: 11,
              fontWeight: 600,
              cursor: pending !== null ? 'wait' : 'pointer',
              fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
            }}
          >
            {pending === 'create_pr' ? 'Creating PR…' : 'Create PR'}
          </button>
          {onOpenInActivity ? (
            <button
              type="button"
              onClick={onOpenInActivity}
              style={{
                paddingTop: 4,
                paddingRight: 10,
                paddingBottom: 4,
                paddingLeft: 10,
                borderRadius: 8,
                borderWidth: 0,
                background: 'transparent',
                color: 'var(--t-text-muted)',
                fontSize: 11,
                fontWeight: 500,
                cursor: 'pointer',
                fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
              }}
            >
              Open in Activity
            </button>
          ) : null}
        </div>
      ) : null}

      {actionNote ? (
        <div style={{ fontSize: 11, color: tone.color, lineHeight: 1.4 }}>
          {actionNote}
        </div>
      ) : null}
      {actionError ? (
        <div style={{ fontSize: 11, color: '#b91c1c', lineHeight: 1.4 }}>
          {actionError}
        </div>
      ) : null}
    </div>
  );
}
