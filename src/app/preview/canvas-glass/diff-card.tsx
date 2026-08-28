'use client';

/**
 * Diff cards — the governance moat as a canvas object (#1232). A lane's
 * review diff in glass: the same continuous-diff read as the default
 * Review surface, with Approve & merge / Request changes living right
 * on the card. Data: GET /api/lanes/<id>/diff; merge: POST
 * /api/orchestrator/merge (the identical path approve_and_merge uses).
 */

import { memo, useEffect, useRef, useState } from 'react';
import { actionReceiptIsInProgress, correlatedActionIsUnsettled, fetchCorrelatedActionReceipt } from '@/lib/orchestrator/action-receipt';
import { CHROME, FONT, scrollFadeY } from './ui';
import { GlassCardShell } from './card-shell';
import { useCanvasRenderProbe } from './perf/render-probe';
import { useScrollBlurFade } from './use-scroll-blur-fade';
import { dispatchWorktreeChanged, useWorktreeDiffRefresh, worktreeRepoPath } from './worktree-diff';

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

type CommitState =
  | { kind: 'closed' }
  | { kind: 'editing'; note?: string }
  | { kind: 'committing' }
  | { kind: 'committed'; hash: string };

function DiffActionButton({
  label,
  onClick,
  disabled = false,
  primary = false,
  type = 'button',
}: {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  primary?: boolean;
  type?: 'button' | 'submit';
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      style={{
        minHeight: 44,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: primary ? 'var(--cnv-ink-muted)' : 'var(--cnv-edge)',
        background: primary ? 'var(--cnv-tint)' : 'transparent',
        borderRadius: 999,
        paddingTop: 0,
        paddingBottom: 0,
        paddingLeft: 13,
        paddingRight: 13,
        fontSize: 10.5,
        fontWeight: primary ? 500 : 300,
        color: primary ? 'var(--cnv-ink)' : 'var(--cnv-ink-muted)',
        cursor: disabled ? 'default' : 'pointer',
        fontFamily: FONT,
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {label}
    </button>
  );
}

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

export const DiffGlassCard = memo(function DiffGlassCard({
  card,
  onMove,
  onResize,
  onFocus,
  onClose,
  onRequestChanges,
  onRefresh,
  onChanged,
}: {
  card: DiffCard;
  onMove: (id: number, x: number, y: number) => void;
  onResize: (id: number, w: number, h: number) => void;
  onFocus: (id: number) => void;
  onClose: (id: number) => void;
  /** Hands the operator's words back to the composer, prefilled. */
  onRequestChanges: (card: DiffCard) => void;
  onRefresh: (cardId: number) => void | Promise<void>;
  onChanged: (cardId: number) => void | Promise<void>;
}) {
  useCanvasRenderProbe('diff', card.id);
  const [merge, setMerge] = useState<MergeState>({ kind: 'idle' });
  const [commit, setCommit] = useState<CommitState>({ kind: 'closed' });
  const [commitMessage, setCommitMessage] = useState('');
  const diffScrollRef = useRef<HTMLDivElement | null>(null);
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const repoPath = worktreeRepoPath(card.laneId);
  useScrollBlurFade(diffScrollRef);
  useWorktreeDiffRefresh({ cardId: card.id, repoPath, onRefresh });

  useEffect(() => () => {
    if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
  }, []);

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

  const closeCommitStrip = () => {
    if (commit.kind === 'committing') return;
    if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
    commitTimerRef.current = null;
    setCommitMessage('');
    setCommit({ kind: 'closed' });
  };

  const commitChanges = async () => {
    const message = commitMessage.trim();
    if (!repoPath || !message || commit.kind === 'committing') return;
    setCommit({ kind: 'committing' });
    try {
      const { response, payload: data } = await fetchCorrelatedActionReceipt<{
        ok?: boolean;
        hash?: string;
        message?: string;
        error?: { message?: string } | string;
      }>('/api/review/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, workspace: repoPath }),
      });
      if (response.ok && data?.ok && typeof data.hash === 'string') {
        setCommit({ kind: 'committed', hash: data.hash.slice(0, 8) });
        dispatchWorktreeChanged(repoPath);
        void onChanged(card.id);
        commitTimerRef.current = setTimeout(closeCommitStrip, 2000);
        return;
      }
      const errorMessage = typeof data?.error === 'string' ? data.error : data?.error?.message;
      setCommit({ kind: 'editing', note: errorMessage || `Commit failed (${response.status}).` });
    } catch (error) {
      setCommit({
        kind: 'editing',
        note: correlatedActionIsUnsettled(error)
          ? 'Commit is still running. Refresh before retrying.'
          : 'Commit request failed. Check the repository and try again.',
      });
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
              {repoPath ? 'No uncommitted changes' : 'No diff is available for this lane.'}
            </span>
          ) : (
            card.diff.split('\n').map((line, index) => (
              <div key={index} style={{ fontFamily: MONO, fontSize: CHROME.bodySize, lineHeight: 1.55, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', paddingLeft: 'calc(4px + 2ch)', textIndent: '-2ch', paddingRight: 4, borderRadius: 3, ...diffLineStyle(line) }}>
                {line || ' '}
              </div>
            ))
          )}
        </div>

        {repoPath && commit.kind === 'closed' ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 6, paddingBottom: 14, paddingLeft: 16, paddingRight: 16, flexShrink: 0 }}>
            <DiffActionButton label="Commit" primary onClick={() => setCommit({ kind: 'editing' })} />
          </div>
        ) : null}
        {repoPath && commit.kind !== 'closed' ? (
          <form
            onSubmit={(event) => { event.preventDefault(); void commitChanges(); }}
            style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, paddingTop: 8, paddingBottom: 14, paddingLeft: 16, paddingRight: 16, borderTopWidth: 1, borderTopStyle: 'solid', borderTopColor: 'var(--cnv-edge)', flexShrink: 0 }}
          >
            {commit.kind === 'committed' ? (
              <span role="status" style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center', fontSize: CHROME.bodySize, fontWeight: 400, color: 'var(--cnv-ink)', fontFamily: FONT }}>
                Committed {commit.hash}
              </span>
            ) : (
              <>
                <input
                  aria-label="Commit message"
                  autoFocus
                  type="text"
                  maxLength={500}
                  value={commitMessage}
                  disabled={commit.kind === 'committing'}
                  onChange={(event) => setCommitMessage(event.target.value)}
                  placeholder="Commit message"
                  style={{ flex: 1, minWidth: 140, height: 44, boxSizing: 'border-box', borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--cnv-edge)', borderRadius: 10, outline: 'none', background: 'var(--cnv-tint)', color: 'var(--cnv-ink)', paddingTop: 0, paddingBottom: 0, paddingLeft: 12, paddingRight: 12, fontSize: CHROME.bodySize, fontWeight: 300, fontFamily: FONT, opacity: commit.kind === 'committing' ? 0.6 : 1 }}
                />
                <DiffActionButton label={commit.kind === 'committing' ? 'Committing…' : 'Commit'} primary type="submit" disabled={!commitMessage.trim() || commit.kind === 'committing'} />
                <DiffActionButton label="Cancel" disabled={commit.kind === 'committing'} onClick={closeCommitStrip} />
                {commit.kind === 'editing' && commit.note ? (
                  <span role="alert" style={{ flexBasis: '100%', fontSize: CHROME.captionSize, fontWeight: 300, color: 'var(--t-danger)', fontFamily: FONT }}>
                    {commit.note}
                  </span>
                ) : null}
              </>
            )}
          </form>
        ) : null}
        {!repoPath ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 6, paddingBottom: 14, paddingLeft: 16, paddingRight: 16, flexShrink: 0 }}>
            {merge.kind === 'merged' ? (
              <span style={{ fontSize: CHROME.bodySize, fontWeight: 400, color: '#a78bfa', fontFamily: FONT }}>Merged — the lane is on main.</span>
            ) : (
              <>
                <DiffActionButton label={merge.kind === 'merging' ? 'Merging…' : 'Approve & merge'} primary disabled={merge.kind === 'merging'} onClick={() => { void approve(); }} />
                <DiffActionButton label="Request changes" onClick={() => onRequestChanges(card)} />
              </>
            )}
            {merge.kind === 'blocked' ? (
              <span style={{ flex: 1, fontSize: CHROME.captionSize, fontWeight: 300, color: '#f8a5a5', fontFamily: FONT, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={merge.note}>
                {merge.note}
              </span>
            ) : null}
          </div>
        ) : null}
    </GlassCardShell>
  );
});
