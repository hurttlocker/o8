'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { orchestratorRuntimeTone, orchestratorStatusTone } from '@/lib/orchestrator/display';
import { deriveGithubIssueUrl } from '@/lib/orchestrator/issue-url';
import { packetReleaseBlockedBy } from '@/lib/orchestrator/store';
import type { OrchestratorPacket, OrchestratorWorkspaceTarget } from '@/lib/orchestrator/types';
import { hasPacketBranchTarget } from '@/components/desktop/thoughts/mission-panel/branchTarget';
import { ContextRecallCard } from '@/components/desktop/thoughts/ContextRecallCard';
import { PacketActionStrip } from '@/components/desktop/thoughts/PacketActionStrip';
import { PacketDetailsPopover } from '@/components/desktop/thoughts/PacketDetailsPopover';
import type { EditingField, ReviewPanelState } from './types';
import { PacketMetaRows } from './PacketMetaRows';
import { PacketReviewCard } from './PacketReviewCard';
import { PacketBuyinDocPane } from './review-card/PacketBuyinDocPane';
import { PacketReviewPanel } from './PacketReviewPanel';
import { ArtifactStrip } from '@/components/desktop/artifacts/ArtifactStrip';
import { useArtifacts } from '@/components/desktop/artifacts/useArtifacts';
import { PacketSpecEditor } from './PacketSpecEditor';
import { RejectedFeedbackPanel } from './RejectedFeedbackPanel';
import { PacketTabStrip, type PacketTabId } from '@/components/desktop/orchestrator/PacketTabStrip';
import { LivingAgentPanel } from '@/components/desktop/orchestrator/LivingAgentPanel';
import { AgentStatusDot, agentStatusToDotState } from '@/components/desktop/AgentStatusDot';
import { packetVisualState } from '@/components/desktop/repo-focus/utils';
import { PacketSpendLine } from './PacketSpendLine';

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
  /** Operator hard-stop for a live agent. Optional — surfaces only where wired. */
  onStop?: () => void;
  onOpenReviewDiff?: () => void;
}
// Packets that belong to a best-of-n comparison group render via
// ComparisonCard at the ThoughtsMissionPanel level. PacketCard is the
// single-packet path; guard here so a misplaced packet
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
  onStop,
  onOpenReviewDiff,
}: PacketCardProps) {
  const statusMeta = orchestratorStatusTone(packet.status);
  const runtimeMeta = orchestratorRuntimeTone(packet.runtime);
  const dependencyBlocker = packetReleaseBlockedBy(packet, allPackets);
  const hasBranchTarget = hasPacketBranchTarget(packet.branchTarget);
  const terminalPacket = packet.releaseState === 'released' || packet.status === 'released' || packet.status === 'archived' || packet.status === 'awaiting_review';
  const recoveryMessage = packet.recovery?.message ?? null;
  const visibleBlocker = recoveryMessage ?? (terminalPacket ? null : (packet.blockedReason ?? (dependencyBlocker ? `Waiting on ${dependencyBlocker.referenceLabel}` : null)));
  const canShowLaunchAction = !terminalPacket && !packet.archivedAt && packet.queueState !== 'held' && !dependencyBlocker;
  const canLaunch = canShowLaunchAction && hasBranchTarget;
  const hasInteractiveLane = Boolean(packet.lane?.laneId || packet.lane?.sessionKey || (packet.lane?.tileId && packet.lane?.tabId));
  const matchedTarget = workspaceTargets.find((target) => target.localPath === packet.workspaceTargetPath) ?? null;
  const targetLabel = matchedTarget?.label ?? null;
  const targetRepoName = matchedTarget?.repoName ?? null;
  const showReviewSection = Boolean(packet.lane?.laneId) && (
    packet.status === 'awaiting_review'
    || (packet.status === 'blocked' && packet.blockedReason === 'Awaiting operator input')
  );
  // #729 — Hero review surface for `awaiting_review` packets. The lighter
  // PacketReviewPanel still owns the `blocked + Awaiting operator input` case
  // (where the orchestrator hasn't moved the packet to awaiting_review yet but
  // is gated on operator input).
  const showHeroReviewCard = Boolean(packet.lane?.laneId) && packet.status === 'awaiting_review';
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

  // #1147 — visual proof captured for this packet. Fetched only while expanded
  // (the strip lives in the expanded body). When empty it self-hides unless
  // we're on a review surface, where "no visual proof" is the honest signal.
  const { artifacts: packetArtifacts } = useArtifacts({ packetId: packet.id, enabled: isExpanded });

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

  // #888/#893 — packet view tabs. Default = Agents; remember last-active
  // per-packet via localStorage so re-expanding lands on the same tab.
  const tabStorageKey = `cortex-ide:packet-tab:${packet.id}`;
  const [activeTab, setActiveTab] = useState<PacketTabId>('agents');
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(tabStorageKey);
      if (raw === 'agents' || raw === 'context' || raw === 'changes' || raw === 'files') {
        setActiveTab(raw);
      }
    } catch {
      // ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [packet.id]);
  const handleTabChange = useCallback((tab: PacketTabId) => {
    setActiveTab(tab);
    if (typeof window === 'undefined') return;
    try { window.localStorage.setItem(tabStorageKey, tab); } catch { /* ignore */ }
  }, [tabStorageKey]);

  // Notification dot on Agents — verifier flagged or rejected, OR a sub-agent
  // finished and the packet is awaiting review.
  const agentsHasNotification = (packet.review?.findings?.length ?? 0) > 0
    || packet.review?.approved === false
    || packet.status === 'awaiting_review';

  // Changes count — files modified from review state (best-effort).
  const changesCount = reviewState?.snapshot?.changedFiles?.length ?? null;

  // Files tab content — predictedFiles or actual changed files.
  const filesList: string[] = useMemo(() => {
    const fromReview = reviewState?.snapshot?.changedFiles?.map((f) => f.path) ?? [];
    if (fromReview.length > 0) return fromReview;
    return packet.predictedFiles ?? packet.allowedFiles ?? [];
  }, [packet.predictedFiles, packet.allowedFiles, reviewState?.snapshot?.changedFiles]);

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
          <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 6, height: 6, flexShrink: 0 }}>
            <AgentStatusDot state={agentStatusToDotState(packetVisualState(packet))} />
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 11, fontWeight: 400, lineHeight: 1.35, color: 'var(--t-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', letterSpacing: '-0.1px' }}>
              {packet.title}
            </span>
            <span style={{ display: 'block', marginTop: 1, fontSize: 9, lineHeight: 1.3, color: 'var(--t-text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {orchestratorRuntimeTone(packet.runtime).label}
            </span>
          </span>
          <span style={{ flexShrink: 0, fontSize: 9, fontWeight: 300, color: statusMeta.color, letterSpacing: '-0.1px' }}>
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
              fontWeight: 400,
              cursor: canLaunch ? 'pointer' : 'not-allowed',
              opacity: canLaunch ? 1 : 0.5,
              letterSpacing: '-0.1px',
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

          {/* #1492 — buy-in doc affordance on the released/merged card. Renders
              nothing unless a doc is ready (no placeholder when absent). */}
          <PacketBuyinDocPane packet={packet} />

          {/* #888/#893 — packet view tabs. Each tab pivots the body content
              while DETAILS / Actions / Hold-Archive-Delete / review and
              rejected panels remain visible across all tabs. */}
          <PacketTabStrip
            active={activeTab}
            onChange={handleTabChange}
            agentsHasNotification={agentsHasNotification}
            changesCount={changesCount}
          />

          {activeTab === 'agents' ? (
            <LivingAgentPanel packet={packet} />
          ) : null}

          {activeTab === 'context' ? (
            <>
              {/* #742 — Context Recall Card (Directive / Recent Outcomes / Symbol Graph). */}
              <ContextRecallCard packet={packet} repoName={targetRepoName} />
              {/* #773 — Editable spec.md nested under Context per #893. */}
              <PacketSpecEditor packetId={packet.id} />
            </>
          ) : null}

          {activeTab === 'changes' ? (
            <ChangesTabHint onOpenReviewDiff={onOpenReviewDiff} />
          ) : null}

          {activeTab === 'files' ? (
            <FilesTabList files={filesList} />
          ) : null}

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
                transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1)',
                fontFamily: 'var(--font-sans-system)',
              }}
              onMouseEnter={(e) => { if (!detailsAnchor) e.currentTarget.style.background = 'var(--t-divider-subtle)'; }}
              onMouseLeave={(e) => { if (!detailsAnchor) e.currentTarget.style.background = 'transparent'; }}
            >
              <span
                style={{
                  fontSize: 9,
                  fontWeight: 300,
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
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
                fontWeight: 300,
                color: 'var(--t-text-muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
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

          {visibleBlocker ? (
            <div
              style={{
                marginTop: 0,
                paddingTop: 6,
                paddingRight: 10,
                paddingBottom: 6,
                paddingLeft: 10,
                fontSize: 10.5,
                fontWeight: 400,
                color: recoveryMessage ? 'var(--t-accent)' : 'var(--t-danger)',
                backgroundColor: recoveryMessage ? 'var(--t-accent-soft)' : 'var(--t-danger-soft)',
                borderTopWidth: 1,
                borderTopStyle: 'solid',
                borderTopColor: recoveryMessage ? 'var(--t-accent-border)' : 'var(--t-danger-border)',
              }}
            >
              {visibleBlocker}
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
                  fontWeight: 400,
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
                  fontWeight: 400,
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
                fontWeight: 400,
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
                fontWeight: 400,
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(239, 68, 68, 0.08)'; e.currentTarget.style.color = '#ef4444'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--t-text-muted)'; }}
            >
              Delete
            </button>
            <div style={{ flex: 1 }} />
            {canShowLaunchAction && !packet.lane ? (
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
                fontWeight: 400,
                cursor: canLaunch ? 'pointer' : 'not-allowed',
                opacity: canLaunch ? 1 : 0.5,
                letterSpacing: '-0.1px',
              }}
            >
              Launch
              </button>
            ) : (
              <>
                {onStop && packet.lane?.laneId && !packet.operatorStopped
                  && (packet.status === 'running' || packet.status === 'launching' || packet.status === 'recovering') ? (
                  <button
                    type="button"
                    onClick={onStop}
                    style={{
                      borderWidth: 0,
                      background: 'transparent',
                      color: '#ef4444',
                      paddingTop: 4,
                      paddingRight: 8,
                      paddingBottom: 4,
                      paddingLeft: 8,
                      borderRadius: 5,
                      fontSize: 10.5,
                      fontWeight: 400,
                      cursor: 'pointer',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(239, 68, 68, 0.08)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    Stop
                  </button>
                ) : null}
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
                      fontWeight: 400,
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
                      fontWeight: 400,
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

          {(packetArtifacts.length > 0 || showHeroReviewCard || showReviewSection) ? (
            <div style={{ paddingTop: 4, paddingRight: 10, paddingBottom: 10, paddingLeft: 10 }}>
              <ArtifactStrip artifacts={packetArtifacts} showEmpty={showHeroReviewCard || showReviewSection} />
            </div>
          ) : null}

          {showHeroReviewCard ? (
            <PacketReviewCard
              packet={packet}
              reviewState={reviewState}
            />
          ) : showReviewSection ? (
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
                borderTopWidth: showReviewSection || showHeroReviewCard ? 0 : 1,
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
          <PacketSpendLine packet={packet} />
          {targetLabel ? <><span style={{ fontSize: 10, color: 'var(--t-text-muted)' }}>·</span><span style={{ fontSize: 10, color: 'var(--t-text-muted)' }}>{targetLabel}</span></> : null}
          {packet.lane ? <><span style={{ fontSize: 10, color: 'var(--t-text-muted)' }}>·</span><span style={{ fontSize: 10, color: '#22c55e', fontWeight: 400 }}>Live</span></> : null}
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

function ChangesTabHint({ onOpenReviewDiff }: { onOpenReviewDiff?: () => void }) {
  return (
    <div
      style={{
        paddingTop: 14,
        paddingRight: 14,
        paddingBottom: 14,
        paddingLeft: 14,
        fontSize: 11,
        color: 'var(--t-text-muted)',
        lineHeight: 1.55,
        fontFamily: 'var(--font-sans-system)',
      }}
    >
      <div>Reviewable changes for this packet are the branch diff against the refreshed base.</div>
      {onOpenReviewDiff ? (
        <button
          type="button"
          onClick={onOpenReviewDiff}
          style={{
            marginTop: 10,
            minHeight: 30,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-input-border)',
            borderRadius: 8,
            background: 'var(--t-input-bg)',
            color: 'var(--t-text)',
            paddingTop: 5,
            paddingRight: 10,
            paddingBottom: 5,
            paddingLeft: 10,
            fontSize: 11,
            fontWeight: 650,
            fontFamily: 'var(--font-sans-system)',
            cursor: 'pointer',
          }}
        >
          Open branch diff
        </button>
      ) : null}
    </div>
  );
}

function FilesTabList({ files }: { files: string[] }) {
  if (files.length === 0) {
    return (
      <div
        style={{
          paddingTop: 14,
          paddingRight: 14,
          paddingBottom: 14,
          paddingLeft: 14,
          fontSize: 11,
          color: 'var(--t-text-muted)',
          lineHeight: 1.55,
          fontFamily: 'var(--font-sans-system)',
        }}
      >
        No predicted or changed files yet. Files appear here once the agent runs.
      </div>
    );
  }
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        paddingTop: 6,
        paddingRight: 6,
        paddingBottom: 6,
        paddingLeft: 6,
        fontFamily: 'var(--font-mono, "SF Mono", Menlo, monospace)',
      }}
    >
      {files.map((file) => (
        <div
          key={file}
          style={{
            paddingTop: 4,
            paddingRight: 8,
            paddingBottom: 4,
            paddingLeft: 8,
            fontSize: 10.5,
            color: 'var(--t-text-secondary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            wordBreak: 'break-all',
          }}
          title={file}
        >
          {file}
        </div>
      ))}
    </div>
  );
}
