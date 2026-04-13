'use client';

import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { ReviewChangedFile, ReviewPanelState } from './types';

interface PacketReviewPanelProps {
  packet: OrchestratorPacket;
  reviewState: ReviewPanelState | null;
  onReviewAction: (verb: 'create_pr' | 'merge') => void;
  onToggleShowAllFiles: () => void;
}

export function PacketReviewPanel({
  packet,
  reviewState,
  onReviewAction,
  onToggleShowAllFiles,
}: PacketReviewPanelProps) {
  const reviewFiles: ReviewChangedFile[] = reviewState?.snapshot?.changedFiles ?? [];
  const reviewWarnings = reviewState?.snapshot?.warnings ?? [];
  const reviewFileCount = reviewFiles.length;
  const reviewAdditions = reviewFiles.reduce((sum, file) => sum + Math.max(0, file.additions ?? 0), 0);
  const reviewDeletions = reviewFiles.reduce((sum, file) => sum + Math.max(0, file.deletions ?? 0), 0);
  const visibleReviewFiles = reviewState?.showAllFiles ? reviewFiles : reviewFiles.slice(0, 5);
  const reviewWarningText = reviewWarnings.length > 0 ? reviewWarnings.slice(0, 2).join(' ') : null;

  return (
    <div style={{
      borderRadius: 14,
      background: 'var(--t-panel)',
      border: '1px solid var(--t-panel-border)',
      padding: '10px 11px',
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t-text)' }}>
          Review
        </div>
        <div style={{ fontSize: 11, color: 'var(--t-text-secondary)' }}>
          {reviewState?.loading
            ? 'Loading review...'
            : reviewState?.snapshot?.diffStat?.trim()
              ? reviewState.snapshot.diffStat
              : `${reviewFileCount} files changed, +${reviewAdditions} -${reviewDeletions}`}
        </div>
      </div>

      {reviewWarningText ? (
        <div style={{ fontSize: 11, fontWeight: 600, color: '#b45309', padding: '7px 9px', borderRadius: 8, background: 'rgba(245, 158, 11, 0.08)', border: '1px solid rgba(245, 158, 11, 0.16)' }}>
          {reviewWarningText}
        </div>
      ) : null}

      {reviewState?.error ? (
        <div style={{ fontSize: 11, fontWeight: 600, color: '#b91c1c', padding: '7px 9px', borderRadius: 8, background: 'rgba(239, 68, 68, 0.05)', border: '1px solid rgba(239, 68, 68, 0.12)' }}>
          {reviewState.error}
        </div>
      ) : null}

      {!reviewState?.error && reviewState?.loading ? (
        <div style={{ fontSize: 11, color: 'var(--t-text-secondary)', opacity: 0.7 }}>
          Loading review snapshot...
        </div>
      ) : null}

      {!reviewState?.loading && reviewFiles.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {visibleReviewFiles.map((file) => {
            const statusTone = file.status === 'added'
              ? { color: '#16a34a', background: 'rgba(34, 197, 94, 0.08)', border: 'rgba(34, 197, 94, 0.18)' }
              : file.status === 'deleted'
                ? { color: '#dc2626', background: 'rgba(239, 68, 68, 0.08)', border: 'rgba(239, 68, 68, 0.16)' }
                : file.status === 'renamed'
                  ? { color: '#7c3aed', background: 'rgba(139, 92, 246, 0.08)', border: 'rgba(139, 92, 246, 0.16)' }
                  : file.status === 'untracked'
                    ? { color: '#0f766e', background: 'rgba(20, 184, 166, 0.08)', border: 'rgba(20, 184, 166, 0.16)' }
                    : { color: '#2563eb', background: 'rgba(37, 99, 235, 0.08)', border: 'rgba(37, 99, 235, 0.16)' };
            return (
              <div key={`${packet.id}:${file.path}`} style={{
                display: 'grid',
                gridTemplateColumns: '1fr auto auto',
                gap: 8,
                alignItems: 'center',
                padding: '7px 8px',
                borderRadius: 10,
                background: 'rgba(148, 163, 184, 0.06)',
                border: '1px solid rgba(148, 163, 184, 0.12)',
              }}>
                <span style={{
                  fontSize: 11,
                  color: 'var(--t-text)',
                  fontFamily: 'var(--font-mono, "SF Mono", Menlo, monospace)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>
                  {file.path}
                </span>
                <span style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '2px 6px',
                  borderRadius: 999,
                  border: `1px solid ${statusTone.border}`,
                  background: statusTone.background,
                  color: statusTone.color,
                  fontSize: 10,
                  fontWeight: 700,
                  textTransform: 'capitalize',
                }}>
                  {file.status}
                </span>
                <span style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 11,
                  fontWeight: 700,
                  fontFamily: 'var(--font-mono, "SF Mono", Menlo, monospace)',
                }}>
                  <span style={{ color: '#16a34a' }}>+{Math.max(0, file.additions ?? 0)}</span>
                  <span style={{ color: '#dc2626' }}>-{Math.max(0, file.deletions ?? 0)}</span>
                </span>
              </div>
            );
          })}
          {reviewFiles.length > 5 ? (
            <button
              type="button"
              onClick={onToggleShowAllFiles}
              style={{
                border: 'none',
                background: 'transparent',
                color: '#2563eb',
                fontSize: 11,
                fontWeight: 700,
                cursor: 'pointer',
                padding: 0,
                alignSelf: 'flex-start',
              }}
            >
              {reviewState?.showAllFiles ? 'Show less' : `Show all ${reviewFiles.length} files`}
            </button>
          ) : null}
        </div>
      ) : null}

      {!reviewState?.loading && !reviewState?.error && reviewFiles.length === 0 ? (
        <div style={{ fontSize: 11, color: 'var(--t-text-secondary)' }}>
          Working tree clean.
        </div>
      ) : null}

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={() => onReviewAction('create_pr')}
          disabled={reviewState?.action === 'create_pr' || reviewState?.loading}
          style={{
            border: '1px solid rgba(34, 197, 94, 0.25)',
            background: 'rgba(34, 197, 94, 0.08)',
            color: '#16a34a',
            padding: '6px 10px',
            borderRadius: 8,
            fontSize: 11,
            fontWeight: 700,
            cursor: reviewState?.action === 'create_pr' || reviewState?.loading ? 'default' : 'pointer',
            opacity: reviewState?.action === 'create_pr' || reviewState?.loading ? 0.5 : 1,
          }}
        >
          {reviewState?.action === 'create_pr' ? 'Create PR...' : 'Create PR'}
        </button>
        <button
          type="button"
          onClick={() => onReviewAction('merge')}
          disabled={reviewState?.action === 'merge' || reviewState?.loading}
          style={{
            border: '1px solid rgba(37, 99, 235, 0.2)',
            background: 'rgba(37, 99, 235, 0.06)',
            color: '#2563eb',
            padding: '6px 10px',
            borderRadius: 8,
            fontSize: 11,
            fontWeight: 700,
            cursor: reviewState?.action === 'merge' || reviewState?.loading ? 'default' : 'pointer',
            opacity: reviewState?.action === 'merge' || reviewState?.loading ? 0.5 : 1,
          }}
        >
          {reviewState?.action === 'merge' ? 'Merge...' : 'Merge'}
        </button>
        {reviewState?.prUrl ? (
          <a
            href={reviewState.prUrl}
            target="_blank"
            rel="noreferrer"
            style={{ fontSize: 11, fontWeight: 700, color: '#2563eb', textDecoration: 'none' }}
          >
            Open PR
          </a>
        ) : null}
      </div>

      {reviewState?.actionError ? (
        <div style={{ fontSize: 11, fontWeight: 600, color: '#b91c1c' }}>
          {reviewState.actionError}
        </div>
      ) : null}

      {!reviewState?.actionError && reviewState?.actionNote ? (
        <div style={{ fontSize: 11, color: 'var(--t-text-secondary)' }}>
          {reviewState.actionNote}
        </div>
      ) : null}
    </div>
  );
}
