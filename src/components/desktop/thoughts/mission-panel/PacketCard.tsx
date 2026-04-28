'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { orchestratorRuntimeTone, orchestratorStatusTone } from '@/lib/orchestrator/display';
import { deriveGithubIssueUrl } from '@/lib/orchestrator/issue-url';
import { packetReleaseBlockedBy } from '@/lib/orchestrator/store';
import type { OrchestratorPacket, OrchestratorWorkspaceTarget } from '@/lib/orchestrator/types';
import { hasPacketBranchTarget } from '@/components/desktop/thoughts/mission-panel/branchTarget';
import { PacketActionStrip } from '@/components/desktop/thoughts/PacketActionStrip';
import { PacketDetailsPopover } from '@/components/desktop/thoughts/PacketDetailsPopover';
import type { EditingField, ReviewPanelState } from './types';
import { PacketMetaRows } from './PacketMetaRows';
import { PacketReviewPanel } from './PacketReviewPanel';
import { RejectedFeedbackPanel } from './RejectedFeedbackPanel';

interface PacketCardProps {
  packet: OrchestratorPacket;
  allPackets: OrchestratorPacket[];
  isExpanded: boolean;
  onToggleExpanded: () => void;
  editingField: EditingField;
  onEditingFieldChange: (next: EditingField) => void;
  workspaceTargets: OrchestratorWorkspaceTarget[];
  /** Map of workspace target localPath → repo remoteUrl. Used as a fallback when
   *  `packet.issue?.url` is absent so the action strip's "open" pill can still
   *  reconstruct an issue URL from packet.referenceLabel + remoteUrl. */
  repoRemoteUrlByPath?: Record<string, string | null | undefined>;
  reviewState: ReviewPanelState | null;
  onPatch: (updater: (packet: OrchestratorPacket) => OrchestratorPacket) => void;
  onLaunch: () => void;
  onFocus: () => void;
  onDelete: () => void;
  onReviewAction: (verb: 'create_pr' | 'merge') => void;
  onToggleShowAllFiles: () => void;
  onResume: () => void;
}

// #517 — Packets that belong to a best-of-n comparison group render via
// ComparisonCard at the ThoughtsMissionPanel level. PacketCard is the
// single-packet path; guard here as defense in depth so a misplaced packet
// never flashes as a rogue single-card row.

export function PacketCard({
  packet,
  allPackets,
  isExpanded,
  onToggleExpanded,
  editingField,
  onEditingFieldChange,
  workspaceTargets,
  repoRemoteUrlByPath,
  reviewState,
  onPatch,
  onLaunch,
  onFocus,
  onDelete,
  onReviewAction,
  onToggleShowAllFiles,
  onResume,
}: PacketCardProps) {
  const statusMeta = orchestratorStatusTone(packet.status);
  const runtimeMeta = orchestratorRuntimeTone(packet.runtime);
  const dependencyBlocker = packetReleaseBlockedBy(packet, allPackets);
  const hasBranchTarget = hasPacketBranchTarget(packet.branchTarget);
  const canShowLaunchAction = !packet.archivedAt && packet.releaseState !== 'released' && packet.queueState !== 'held' && !dependencyBlocker;
  const canLaunch = canShowLaunchAction && hasBranchTarget;
  const hasInteractiveLane = Boolean(packet.lane?.tileId && packet.lane?.tabId);
  const targetLabel = workspaceTargets.find((target) => target.localPath === packet.workspaceTargetPath)?.label ?? null;
  const showReviewSection = Boolean(packet.lane?.laneId) && (
    packet.status === 'awaiting_review'
    || (packet.status === 'blocked' && packet.blockedReason === 'Awaiting operator input')
  );
  // #662 — Rejected packets get a one-click rerun-with-feedback panel.
  // Detect via packet.review?.approved === false rather than packet.status,
  // since submitPacketReview leaves status untouched.
  const isRejected = packet.review?.approved === false;

  const packetPrompt = [packet.title, packet.summary].map((part) => part.trim()).filter(Boolean).join('\n\n') || null;

  // #626 — Prefer the snapshot captured at mission creation; fall back to
  // reconstructing from referenceLabel + the repo's remoteUrl.
  const resolvedIssueUrl = useMemo(() => {
    const cached = packet.issue?.url?.trim();
    if (cached) return cached;
    const remoteUrl = packet.workspaceTargetPath
      ? repoRemoteUrlByPath?.[packet.workspaceTargetPath] ?? null
      : null;
    return deriveGithubIssueUrl(packet.referenceLabel, remoteUrl);
  }, [packet.issue?.url, packet.referenceLabel, packet.workspaceTargetPath, repoRemoteUrlByPath]);

  // #615 — Details popover state. Anchored to the DETAILS row via DOMRect snapshot.
  const detailsRowRef = useRef<HTMLButtonElement | null>(null);
  const [detailsAnchor, setDetailsAnchor] = useState<DOMRect | null>(null);
  const openDetails = useCallback(() => {
    const node = detailsRowRef.current;
    if (!node) return;
    setDetailsAnchor(node.getBoundingClientRect());
  }, []);
  const closeDetails = useCallback(() => {
    setDetailsAnchor(null);
  }, []);

  // #517 — Packets in a best-of-n comparison group render via ComparisonCard at
  // the ThoughtsMissionPanel level. Guard AFTER all hooks so the hook order
  // stays stable render-to-render.
  if (packet.comparisonGroupId) {
    return null;
  }

  return (
    <div
      style={{
        borderRadius: 14,
        background: 'var(--t-panel)',
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-panel-border)',
        flexShrink: 0,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          width: '100%',
          paddingTop: 6,
          paddingRight: 10,
          paddingBottom: 6,
          paddingLeft: 10,
          minHeight: 34,
        }}
      >
        <button
          type="button"
          onClick={onToggleExpanded}
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            textAlign: 'left',
            padding: 0,
          }}
        >
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: statusMeta.color, boxShadow: `0 0 6px ${statusMeta.border}`, flexShrink: 0 }} />
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 11, fontWeight: 600, lineHeight: 1.35, color: 'var(--t-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', letterSpacing: '-0.01em' }}>
              {packet.title}
            </span>
            <span style={{ display: 'block', marginTop: 1, fontSize: 9, lineHeight: 1.3, color: 'var(--t-text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {orchestratorRuntimeTone(packet.runtime).label}
            </span>
          </span>
          <span style={{ flexShrink: 0, fontSize: 9, fontWeight: 600, color: statusMeta.color, letterSpacing: '-0.01em' }}>
            {statusMeta.label}
          </span>
          <svg width={10} height={10} viewBox="0 0 10 10" fill="none" stroke="var(--t-text-muted)" strokeWidth="1.5" strokeLinecap="round" style={{ flexShrink: 0, transform: isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 150ms cubic-bezier(0.22, 1, 0.36, 1)' }}>
            <path d="M2.5 3.5L5 6L7.5 3.5" />
          </svg>
        </button>
        {canShowLaunchAction && !packet.lane ? (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onLaunch(); }}
            disabled={!canLaunch}
            title="Dispatch this packet"
            style={{
              flexShrink: 0,
              borderWidth: 0,
              background: '#2563eb',
              color: '#fff',
              paddingTop: 4,
              paddingRight: 10,
              paddingBottom: 4,
              paddingLeft: 10,
              borderRadius: 12,
              fontSize: 10,
              fontWeight: 700,
              cursor: canLaunch ? 'pointer' : 'not-allowed',
              opacity: canLaunch ? 1 : 0.5,
              letterSpacing: '-0.01em',
            }}
          >
            Launch
          </button>
        ) : null}
      </div>

      {isExpanded ? (
        <div style={{ display: 'flex', flexDirection: 'column', borderTopWidth: 1, borderTopStyle: 'solid', borderTopColor: 'var(--t-divider-subtle)' }}>
          <PacketMetaRows
            packet={packet}
            workspaceTargets={workspaceTargets}
            editingField={editingField}
            onEditingFieldChange={onEditingFieldChange}
            onPatch={onPatch}
          />

          {/* #615 — DETAILS row (read-only popover trigger). */}
          <div
            data-packet-row
            style={{
              borderTopWidth: 1,
              borderTopStyle: 'solid',
              borderTopColor: 'var(--t-divider-subtle)',
              position: 'relative',
            }}
          >
            <button
              ref={detailsRowRef}
              type="button"
              onClick={openDetails}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                minHeight: 28,
                paddingTop: 5,
                paddingRight: 10,
                paddingBottom: 5,
                paddingLeft: 10,
                width: '100%',
                borderWidth: 0,
                background: detailsAnchor ? 'var(--t-divider-subtle)' : 'transparent',
                textAlign: 'left',
                cursor: 'pointer',
                transition: 'background 120ms ease',
                fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
              }}
              onMouseEnter={(e) => { if (!detailsAnchor) e.currentTarget.style.background = 'var(--t-divider-subtle)'; }}
              onMouseLeave={(e) => { if (!detailsAnchor) e.currentTarget.style.background = 'transparent'; }}
            >
              <span
                style={{
                  fontSize: 9,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  color: 'var(--t-text-muted)',
                  width: 58,
                  flexShrink: 0,
                }}
              >
                details
              </span>
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: 11.5,
                  color: 'var(--t-text-muted)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  letterSpacing: '-0.005em',
                }}
              >
                View packet brief
              </span>
              <svg
                width={9}
                height={9}
                viewBox="0 0 10 10"
                fill="none"
                stroke="var(--t-text-faint)"
                strokeWidth="1.5"
                strokeLinecap="round"
                style={{ flexShrink: 0, opacity: 0.5 }}
              >
                <path d="M2.5 3.5L5 6L7.5 3.5" />
              </svg>
            </button>
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 12,
              paddingTop: 7,
              paddingRight: 10,
              paddingBottom: 7,
              paddingLeft: 10,
              borderTopWidth: 1,
              borderTopStyle: 'solid',
              borderTopColor: 'var(--t-divider-subtle)',
            }}
          >
            <span
              style={{
                fontSize: 9,
                fontWeight: 700,
                color: 'var(--t-text-muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                paddingTop: 5,
                flexShrink: 0,
                width: 56,
              }}
            >
              Actions
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <PacketActionStrip
                packetId={packet.id}
                issueUrl={resolvedIssueUrl}
                prompt={packetPrompt}
                runtime={packet.runtime}
              />
            </div>
          </div>

          {(packet.blockedReason || dependencyBlocker) ? (
            <div
              style={{
                marginTop: 0,
                paddingTop: 6,
                paddingRight: 10,
                paddingBottom: 6,
                paddingLeft: 10,
                fontSize: 10.5,
                fontWeight: 600,
                color: '#b91c1c',
                background: 'rgba(239, 68, 68, 0.06)',
                borderTopWidth: 1,
                borderTopStyle: 'solid',
                borderTopColor: 'rgba(239, 68, 68, 0.14)',
              }}
            >
              {packet.blockedReason ?? `Waiting on ${dependencyBlocker?.referenceLabel}`}
            </div>
          ) : null}

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              paddingTop: 7,
              paddingRight: 10,
              paddingBottom: 7,
              paddingLeft: 10,
              borderTopWidth: 1,
              borderTopStyle: 'solid',
              borderTopColor: 'var(--t-divider-subtle)',
            }}
          >
            {packet.queueState !== 'held' && !packet.lane ? (
              <button
                type="button"
                onClick={() => onPatch((current) => ({ ...current, queueState: 'held', blockedReason: 'Held by operator' }))}
                style={{
                  borderWidth: 0,
                  background: 'transparent',
                  color: 'var(--t-text-muted)',
                  paddingTop: 4,
                  paddingRight: 8,
                  paddingBottom: 4,
                  paddingLeft: 8,
                  borderRadius: 5,
                  fontSize: 10.5,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-divider-subtle)'; e.currentTarget.style.color = 'var(--t-text)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--t-text-muted)'; }}
              >
                Hold
              </button>
            ) : packet.queueState === 'held' ? (
              <button
                type="button"
                onClick={() => onPatch((current) => ({ ...current, queueState: 'queued', blockedReason: null }))}
                style={{
                  borderWidth: 0,
                  background: 'transparent',
                  color: '#b91c1c',
                  paddingTop: 4,
                  paddingRight: 8,
                  paddingBottom: 4,
                  paddingLeft: 8,
                  borderRadius: 5,
                  fontSize: 10.5,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(239, 68, 68, 0.08)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                Unhold
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => onPatch((current) => ({ ...current, archivedAt: current.archivedAt ? null : new Date().toISOString() }))}
              style={{
                borderWidth: 0,
                background: 'transparent',
                color: 'var(--t-text-muted)',
                paddingTop: 4,
                paddingRight: 8,
                paddingBottom: 4,
                paddingLeft: 8,
                borderRadius: 5,
                fontSize: 10.5,
                fontWeight: 600,
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-divider-subtle)'; e.currentTarget.style.color = 'var(--t-text)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--t-text-muted)'; }}
            >
              {packet.archivedAt ? 'Restore' : 'Archive'}
            </button>
            <button
              type="button"
              onClick={onDelete}
              style={{
                borderWidth: 0,
                background: 'transparent',
                color: 'var(--t-text-muted)',
                paddingTop: 4,
                paddingRight: 8,
                paddingBottom: 4,
                paddingLeft: 8,
                borderRadius: 5,
                fontSize: 10.5,
                fontWeight: 600,
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(239, 68, 68, 0.08)'; e.currentTarget.style.color = '#ef4444'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--t-text-muted)'; }}
            >
              Delete
            </button>
            <div style={{ flex: 1 }} />
            {!packet.lane ? (
              <button
                type="button"
                onClick={onLaunch}
                disabled={!canLaunch}
                style={{
                  borderWidth: 0,
                background: canLaunch ? '#2563eb' : 'var(--t-divider)',
                color: canLaunch ? '#fff' : 'var(--t-text-faint)',
                paddingTop: 4,
                paddingRight: 10,
                paddingBottom: 4,
                paddingLeft: 10,
                borderRadius: 12,
                fontSize: 10.5,
                fontWeight: 700,
                cursor: canLaunch ? 'pointer' : 'not-allowed',
                opacity: canLaunch ? 1 : 0.5,
                letterSpacing: '-0.01em',
              }}
            >
              Launch
              </button>
            ) : (
              <>
                {packet.lane?.laneId && (packet.status === 'idle' || packet.status === 'awaiting_review' || packet.status === 'recovering') ? (
                  <button
                    type="button"
                    onClick={onResume}
                    style={{
                      borderWidth: 0,
                      background: 'transparent',
                      color: '#2563eb',
                      paddingTop: 4,
                      paddingRight: 8,
                      paddingBottom: 4,
                      paddingLeft: 8,
                      borderRadius: 5,
                      fontSize: 10.5,
                      fontWeight: 700,
                      cursor: 'pointer',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(37, 99, 235, 0.08)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    Resume
                  </button>
                ) : null}
                {hasInteractiveLane ? (
                  <button
                    type="button"
                    onClick={onFocus}
                    style={{
                      borderWidth: 0,
                      background: '#2563eb',
                      color: '#fff',
                      paddingTop: 4,
                      paddingRight: 10,
                      paddingBottom: 4,
                      paddingLeft: 10,
                      borderRadius: 5,
                      fontSize: 10.5,
                      fontWeight: 700,
                      cursor: 'pointer',
                      letterSpacing: '-0.01em',
                    }}
                  >
                    Focus
                  </button>
                ) : null}
              </>
            )}
          </div>

          {showReviewSection ? (
            <PacketReviewPanel
              packet={packet}
              reviewState={reviewState}
              onReviewAction={onReviewAction}
              onToggleShowAllFiles={onToggleShowAllFiles}
            />
          ) : null}

          {isRejected ? (
            <div
              style={{
                paddingTop: 8,
                paddingRight: 10,
                paddingBottom: 10,
                paddingLeft: 10,
                borderTopWidth: showReviewSection ? 0 : 1,
                borderTopStyle: 'solid',
                borderTopColor: 'var(--t-divider-subtle)',
              }}
            >
              <RejectedFeedbackPanel packet={packet} />
            </div>
          ) : null}
        </div>
      ) : (
        <div style={{ padding: '0 14px 8px', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 10, color: 'var(--t-text-muted)' }}>{runtimeMeta.label}</span>
          {targetLabel ? <><span style={{ fontSize: 10, color: 'var(--t-text-muted)' }}>·</span><span style={{ fontSize: 10, color: 'var(--t-text-muted)' }}>{targetLabel}</span></> : null}
          {packet.lane ? <><span style={{ fontSize: 10, color: 'var(--t-text-muted)' }}>·</span><span style={{ fontSize: 10, color: '#22c55e', fontWeight: 600 }}>Live</span></> : null}
          {packet.lane?.laneId ? <><span style={{ fontSize: 10, color: 'var(--t-text-muted)' }}>·</span><span style={{ fontSize: 10, color: 'var(--t-text-muted)', fontFamily: 'var(--font-mono, "SF Mono", Menlo, monospace)' }}>{packet.lane.laneId.slice(0, 12)}</span></> : null}
        </div>
      )}

      {detailsAnchor ? (
        <PacketDetailsPopover
          packet={packet}
          anchorRect={detailsAnchor}
          onClose={closeDetails}
        />
      ) : null}
    </div>
  );
}
