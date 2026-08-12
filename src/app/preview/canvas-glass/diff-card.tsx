'use client';

/**
 * Diff cards — the governance moat as a canvas object (#1232). A lane's
 * review diff in glass: the same continuous-diff read as the default
 * Review surface, with Approve & merge / Request changes living right
 * on the card. Data: GET /api/lanes/<id>/diff; merge: POST
 * /api/orchestrator/merge (the identical path approve_and_merge uses).
 */

import { useRef, useState } from 'react';
import { actionReceiptIsInProgress, correlatedActionIsUnsettled, fetchCorrelatedActionReceipt } from '@/lib/orchestrator/action-receipt';
import { CHROME, FONT, scrollFadeY } from './ui';
import { GlassCardShell } from './card-shell';
import { useScrollBlurFade } from './use-scroll-blur-fade';

const MONO = '"SF Mono", ui-monospace, "Cascadia Code", Menlo, monospace';
export const DIFF_MIN_W = 380;
export const DIFF_MIN_H = 260;

export interface DiffCard {
  id: number;
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  laneId: string;
  packetId: string | null;
  title: string;
  branch: string | null;
  stat: string;
  diff: string;
  truncated: boolean;
}

type MergeState =
  | { kind: 'idle' }
  | { kind: 'merging' }
  | { kind: 'merged' }
  | { kind: 'blocked'; note: string };

/** One diff line — the default-side read, in glass tones. */
function diffLineStyle(line: string): React.CSSProperties {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git')) {
    return { color: 'var(--cnv-ink)', fontWeight: 500, marginTop: line.startsWith('diff --git') ? 10 : 0 };
  }
  if (line.startsWith('@@')) return { color: '#d4a04c', opacity: 0.85 };
  if (line.startsWith('+')) return { color: '#6ee7a0', background: 'rgba(34,197,94,0.08)' };
  if (line.startsWith('-')) return { color: '#f8a5a5', background: 'rgba(239,68,68,0.07)' };
  return { color: 'var(--cnv-ink-muted)' };
}

export function DiffGlassCard({
  card,
  onMove,
  onResize,
  onFocus,
  onClose,
  onRequestChanges,
}: {
  card: DiffCard;
  onMove: (id: number, x: number, y: number) => void;
  onResize: (id: number, w: number, h: number) => void;
  onFocus: (id: number) => void;
  onClose: (id: number) => void;
  /** Hands the operator's words back to the composer, prefilled. */
  onRequestChanges: (card: DiffCard) => void;
}) {
  const [merge, setMerge] = useState<MergeState>({ kind: 'idle' });
  const diffScrollRef = useRef<HTMLDivElement | null>(null);
  useScrollBlurFade(diffScrollRef);

  const approve = async () => {
    if (merge.kind === 'merging' || merge.kind === 'merged') return;
    if (!card.packetId) {
      setMerge({ kind: 'blocked', note: 'No packet on this lane — merge it from the default side.' });
      return;
    }
    setMerge({ kind: 'merging' });
    try {
      const { response, payload: data } = await fetchCorrelatedActionReceipt<{
        ok?: boolean;
        result?: {
          merged?: boolean;
          status?: string;
          inProgress?: boolean;
          note?: string;
          blockers?: Array<{ note?: string; reason?: string } | string>;
        };
        error?: { message?: string } | string;
      }>('/api/orchestrator/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packetId: card.packetId, idempotencyKey: crypto.randomUUID() }),
      });
      if (response.ok && data?.ok && actionReceiptIsInProgress(response.status, data.result)) {
        setMerge({ kind: 'merging' });
        return;
      }
      if (response.ok && data?.ok && data.result?.merged) {
        setMerge({ kind: 'merged' });
        return;
      }
      const blockers = Array.isArray(data?.result?.blockers)
        ? data.result.blockers.map((blocker) => typeof blocker === 'string' ? blocker : blocker?.note ?? blocker?.reason ?? '').filter(Boolean).join(' · ')
        : '';
      const errorMessage = typeof data?.error === 'string' ? data.error : data?.error?.message;
      setMerge({
        kind: 'blocked',
        note: blockers || errorMessage || data?.result?.note || `Merge gate said no (${response.status}).`,
      });
    } catch (error) {
      if (correlatedActionIsUnsettled(error)) {
        setMerge({ kind: 'merging' });
        return;
      }
      setMerge({ kind: 'blocked', note: 'Merge request failed — is the lane still alive?' });
    }
  };

  return (
    <GlassCardShell
      card={card}
      cornerHandles
      minW={DIFF_MIN_W}
      minH={DIFF_MIN_H}
      title={card.title}
      badge={card.branch ?? undefined}
      onMove={onMove}
      onResize={onResize}
      onFocus={onFocus}
      onClose={onClose}
    >
        {/* Stat strip — quiet, no divider line. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 2, paddingBottom: 6, paddingLeft: 16, paddingRight: 16 }}>
          <span style={{ flex: 1, fontSize: CHROME.captionSize, fontWeight: 300, color: 'var(--cnv-ink-muted)', fontFamily: MONO, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {card.stat.split('\n').pop()?.trim() || 'No changes'}
            {card.truncated ? '  ·  truncated' : ''}
          </span>
        </div>

        {/* The diff — one continuous read, glass tones. */}
        <div ref={diffScrollRef} style={{ ...scrollFadeY, height: card.h, overflowY: 'auto', overflowX: 'hidden', paddingTop: 2, paddingBottom: 8, paddingLeft: 16, paddingRight: 16, scrollbarWidth: 'thin' } as React.CSSProperties}>
          {card.diff.trim() === '' ? (
            <span style={{ fontSize: CHROME.bodySize, fontWeight: 300, color: 'var(--cnv-ink-muted)', fontFamily: FONT }}>
              Clean worktree — nothing to review on this lane.
            </span>
          ) : (
            card.diff.split('\n').map((line, index) => (
              <div key={index} style={{ fontFamily: MONO, fontSize: CHROME.bodySize, lineHeight: 1.55, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', paddingLeft: 'calc(4px + 2ch)', textIndent: '-2ch', paddingRight: 4, borderRadius: 3, ...diffLineStyle(line) }}>
                {line || ' '}
              </div>
            ))
          )}
        </div>

        {/* Governance row — approve or push back, right here. A worktree
            diff is YOUR uncommitted work, not a lane — no merge actions. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 6, paddingBottom: 14, paddingLeft: 16, paddingRight: 16, flexShrink: 0 }}>
          {card.laneId.startsWith('worktree:') ? (
            <span style={{ fontSize: CHROME.bodySize, fontWeight: 300, color: 'var(--cnv-ink-muted)', fontFamily: FONT }}>
              Your uncommitted changes — commit from a terminal or the dashboard.
            </span>
          ) : merge.kind === 'merged' ? (
            <span style={{ fontSize: CHROME.bodySize, fontWeight: 400, color: '#a78bfa', fontFamily: FONT }}>Merged — the lane is on main.</span>
          ) : (
            <>
              <button
                type="button"
                onClick={() => { void approve(); }}
                disabled={merge.kind === 'merging'}
                style={{
                  borderWidth: 1,
                  borderStyle: 'solid',
                  borderColor: 'var(--cnv-ink-muted)',
                  background: 'rgba(255,255,255,0.1)',
                  borderRadius: 999,
                  paddingTop: 4,
                  paddingBottom: 4,
                  paddingLeft: 13,
                  paddingRight: 13,
                  fontSize: 10.5,
                  fontWeight: 500,
                  color: 'var(--cnv-ink)',
                  cursor: merge.kind === 'merging' ? 'default' : 'pointer',
                  fontFamily: FONT,
                  opacity: merge.kind === 'merging' ? 0.6 : 1,
                }}
              >
                {merge.kind === 'merging' ? 'Merging…' : 'Approve & merge'}
              </button>
              <button
                type="button"
                onClick={() => onRequestChanges(card)}
                style={{
                  borderWidth: 1,
                  borderStyle: 'solid',
                  borderColor: 'var(--cnv-edge)',
                  background: 'transparent',
                  borderRadius: 999,
                  paddingTop: 4,
                  paddingBottom: 4,
                  paddingLeft: 13,
                  paddingRight: 13,
                  fontSize: 10.5,
                  fontWeight: 300,
                  color: 'var(--cnv-ink-muted)',
                  cursor: 'pointer',
                  fontFamily: FONT,
                }}
                onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--cnv-ink)'; }}
                onMouseLeave={(event) => { event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
              >
                Request changes
              </button>
            </>
          )}
          {merge.kind === 'blocked' ? (
            <span style={{ flex: 1, fontSize: CHROME.captionSize, fontWeight: 300, color: '#f8a5a5', fontFamily: FONT, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={merge.note}>
              {merge.note}
            </span>
          ) : null}
        </div>
    </GlassCardShell>
  );
}
