'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ApprovalRecord } from '@/lib/approvals/types';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { ReviewChangedFile, ReviewPanelState } from './types';

interface PacketReviewPanelProps {
  packet: OrchestratorPacket;
  reviewState: ReviewPanelState | null;
  onReviewAction: (verb: 'create_pr' | 'merge') => void;
  onToggleShowAllFiles: () => void;
}

const APPROVAL_POLL_INTERVAL_MS = 3_000;

function isMergeApproval(approval: ApprovalRecord) {
  return approval.continuation?.kind === 'lane' && approval.continuation.verb === 'merge';
}

function selectLatestMergeApproval(approvals: ApprovalRecord[]) {
  return approvals
    .filter(isMergeApproval)
    .sort((left, right) => (
      (right.resolvedAt ?? right.updatedAt) - (left.resolvedAt ?? left.updatedAt)
      || right.createdAt - left.createdAt
    ))[0] ?? null;
}

function approvalStatusLabel(approval: ApprovalRecord) {
  if (approval.status === 'approved') return 'Approved';
  if (approval.status === 'rejected') return 'Rejected';
  return 'Awaiting operator';
}

export function PacketReviewPanel({
  packet,
  reviewState,
  onReviewAction,
  onToggleShowAllFiles,
}: PacketReviewPanelProps) {
  const [mergeApproval, setMergeApproval] = useState<ApprovalRecord | null>(null);
  const [approvalLoading, setApprovalLoading] = useState(false);
  const [approvalBusyAction, setApprovalBusyAction] = useState<'approve' | 'reject' | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [approvalNote, setApprovalNote] = useState<string | null>(null);
  const reviewFiles: ReviewChangedFile[] = reviewState?.snapshot?.changedFiles ?? [];
  const reviewWarnings = reviewState?.snapshot?.warnings ?? [];
  const reviewFileCount = reviewFiles.length;
  const reviewAdditions = reviewFiles.reduce((sum, file) => sum + Math.max(0, file.additions ?? 0), 0);
  const reviewDeletions = reviewFiles.reduce((sum, file) => sum + Math.max(0, file.deletions ?? 0), 0);
  const visibleReviewFiles = reviewState?.showAllFiles ? reviewFiles : reviewFiles.slice(0, 5);
  const reviewWarningText = reviewWarnings.length > 0 ? reviewWarnings.slice(0, 2).join(' ') : null;
  const laneId = packet.lane?.laneId ?? null;
  const approvalQuery = useMemo(() => {
    if (!laneId) return null;
    const params = new URLSearchParams({ status: 'all', packetId: packet.id, laneId });
    return `/api/panel/approvals?${params.toString()}`;
  }, [laneId, packet.id]);
  const gateViolations = mergeApproval?.gateResult?.violations ?? [];
  const visibleGateViolations = gateViolations.slice(0, 3);

  const loadMergeApproval = useCallback(async () => {
    if (!approvalQuery) {
      setMergeApproval(null);
      setApprovalError(null);
      setApprovalNote(null);
      return;
    }

    setApprovalLoading(true);
    try {
      const response = await fetch(approvalQuery, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error('Unable to load packet approvals.');
      }
      const payload = await response.json() as { approvals?: ApprovalRecord[] };
      const nextApproval = selectLatestMergeApproval(payload.approvals ?? []);
      setMergeApproval(nextApproval);
      setApprovalError(null);
      if (nextApproval?.status === 'pending') {
        setApprovalNote(null);
      } else if (nextApproval?.status === 'approved') {
        setApprovalNote(nextApproval.resolution?.note ?? 'Merge gate approved. Merge is continuing.');
      } else if (nextApproval?.status === 'rejected') {
        setApprovalNote(nextApproval.resolution?.note ?? 'Merge gate rejected.');
      } else {
        setApprovalNote(null);
      }
    } catch (error) {
      setApprovalError(error instanceof Error ? error.message : 'Unable to load packet approvals.');
    } finally {
      setApprovalLoading(false);
    }
  }, [approvalQuery]);

  useEffect(() => {
    void loadMergeApproval();
    if (!approvalQuery) return undefined;
    const id = window.setInterval(() => {
      void loadMergeApproval();
    }, APPROVAL_POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [approvalQuery, loadMergeApproval]);

  const resolveMergeApproval = useCallback(async (action: 'approve' | 'reject') => {
    if (!mergeApproval) return;

    setApprovalBusyAction(action);
    setApprovalError(null);
    try {
      const response = await fetch('/api/panel/approvals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: mergeApproval.id, action }),
      });
      const payload = await response.json().catch(() => null) as {
        ok?: boolean;
        note?: string;
        error?: string;
      } | null;
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error ?? `Unable to ${action} this merge gate.`);
      }
      setApprovalNote(payload.note ?? (action === 'approve' ? 'Merge gate approved.' : 'Merge gate rejected.'));
      await loadMergeApproval();
    } catch (error) {
      setApprovalError(error instanceof Error ? error.message : `Unable to ${action} this merge gate.`);
    } finally {
      setApprovalBusyAction(null);
    }
  }, [loadMergeApproval, mergeApproval]);

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
      {mergeApproval ? (
        <div style={{
          borderRadius: 12,
          border: mergeApproval.status === 'pending'
            ? '1px solid rgba(239, 68, 68, 0.28)'
            : mergeApproval.status === 'approved'
              ? '1px solid rgba(34, 197, 94, 0.24)'
              : '1px solid rgba(148, 163, 184, 0.2)',
          background: mergeApproval.status === 'pending'
            ? 'rgba(239, 68, 68, 0.06)'
            : mergeApproval.status === 'approved'
              ? 'rgba(34, 197, 94, 0.08)'
              : 'rgba(148, 163, 184, 0.08)',
          padding: '10px 11px',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: mergeApproval.status === 'pending' ? '#b91c1c' : mergeApproval.status === 'approved' ? '#15803d' : 'var(--t-text-secondary)' }}>
                Merge gate
              </span>
              <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--t-text)' }}>
                {mergeApproval.status === 'pending' ? 'Approve this merge?' : mergeApproval.title}
              </span>
            </div>
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              padding: '3px 8px',
              borderRadius: 999,
              fontSize: 10,
              fontWeight: 700,
              color: mergeApproval.status === 'pending' ? '#b91c1c' : mergeApproval.status === 'approved' ? '#15803d' : 'var(--t-text-secondary)',
              background: mergeApproval.status === 'pending'
                ? 'rgba(239, 68, 68, 0.12)'
                : mergeApproval.status === 'approved'
                  ? 'rgba(34, 197, 94, 0.12)'
                  : 'rgba(148, 163, 184, 0.14)',
            }}>
              {approvalStatusLabel(mergeApproval)}
            </span>
          </div>

          <div style={{ fontSize: 11, lineHeight: 1.55, color: 'var(--t-text-secondary)', whiteSpace: 'pre-wrap' }}>
            {mergeApproval.description || mergeApproval.summary}
          </div>

          {visibleGateViolations.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {visibleGateViolations.map((violation, index) => (
                <div
                  key={`${mergeApproval.id}:${violation.label}:${index}`}
                  style={{
                    padding: '7px 8px',
                    borderRadius: 10,
                    border: '1px solid rgba(239, 68, 68, 0.16)',
                    background: 'rgba(255, 255, 255, 0.52)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2,
                  }}
                >
                  <span style={{ fontSize: 10.5, fontWeight: 700, color: '#991b1b' }}>
                    {violation.label}
                  </span>
                  <span style={{ fontSize: 10.5, color: 'var(--t-text-secondary)', lineHeight: 1.45 }}>
                    {violation.detail}
                  </span>
                </div>
              ))}
            </div>
          ) : null}

          {mergeApproval.status === 'pending' ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={() => { void resolveMergeApproval('approve'); }}
                disabled={approvalBusyAction !== null}
                style={{
                  border: '1px solid rgba(34, 197, 94, 0.28)',
                  background: 'rgba(34, 197, 94, 0.1)',
                  color: '#15803d',
                  padding: '6px 10px',
                  borderRadius: 8,
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: approvalBusyAction !== null ? 'default' : 'pointer',
                  opacity: approvalBusyAction !== null ? 0.6 : 1,
                }}
              >
                {approvalBusyAction === 'approve' ? 'Approving...' : 'Approve'}
              </button>
              <button
                type="button"
                onClick={() => { void resolveMergeApproval('reject'); }}
                disabled={approvalBusyAction !== null}
                style={{
                  border: '1px solid rgba(239, 68, 68, 0.24)',
                  background: 'rgba(239, 68, 68, 0.08)',
                  color: '#b91c1c',
                  padding: '6px 10px',
                  borderRadius: 8,
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: approvalBusyAction !== null ? 'default' : 'pointer',
                  opacity: approvalBusyAction !== null ? 0.6 : 1,
                }}
              >
                {approvalBusyAction === 'reject' ? 'Rejecting...' : 'Reject'}
              </button>
              {approvalLoading ? (
                <span style={{ fontSize: 10.5, color: 'var(--t-text-secondary)' }}>
                  Refreshing approval...
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {approvalError ? (
        <div style={{ fontSize: 11, fontWeight: 600, color: '#b91c1c', padding: '7px 9px', borderRadius: 8, background: 'rgba(239, 68, 68, 0.05)', border: '1px solid rgba(239, 68, 68, 0.12)' }}>
          {approvalError}
        </div>
      ) : null}

      {!approvalError && approvalNote && !mergeApproval ? (
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--t-text-secondary)', padding: '7px 9px', borderRadius: 8, background: 'rgba(148, 163, 184, 0.08)', border: '1px solid rgba(148, 163, 184, 0.16)' }}>
          {approvalNote}
        </div>
      ) : null}

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
