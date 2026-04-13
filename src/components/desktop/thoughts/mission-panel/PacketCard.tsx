'use client';

import { orchestratorRuntimeTone, orchestratorStatusTone } from '@/lib/orchestrator/display';
import { packetReleaseBlockedBy } from '@/lib/orchestrator/store';
import type { OrchestratorPacket, OrchestratorWorkspaceTarget } from '@/lib/orchestrator/types';
import type { EditingField, ReviewPanelState } from './types';
import { PacketMetaRows } from './PacketMetaRows';
import { PacketReviewPanel } from './PacketReviewPanel';

interface PacketCardProps {
  packet: OrchestratorPacket;
  allPackets: OrchestratorPacket[];
  isExpanded: boolean;
  onToggleExpanded: () => void;
  editingField: EditingField;
  onEditingFieldChange: (next: EditingField) => void;
  workspaceTargets: OrchestratorWorkspaceTarget[];
  reviewState: ReviewPanelState | null;
  onPatch: (updater: (packet: OrchestratorPacket) => OrchestratorPacket) => void;
  onLaunch: () => void;
  onFocus: () => void;
  onDelete: () => void;
  onReviewAction: (verb: 'create_pr' | 'merge') => void;
  onToggleShowAllFiles: () => void;
  onResume: () => void;
}

export function PacketCard({
  packet,
  allPackets,
  isExpanded,
  onToggleExpanded,
  editingField,
  onEditingFieldChange,
  workspaceTargets,
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
  const canLaunch = !packet.archivedAt && packet.releaseState !== 'released' && packet.queueState !== 'held' && !dependencyBlocker;
  const hasInteractiveLane = Boolean(packet.lane?.tileId && packet.lane?.tabId);
  const targetLabel = workspaceTargets.find((target) => target.localPath === packet.workspaceTargetPath)?.label ?? null;
  const showReviewSection = packet.status === 'awaiting_review' && Boolean(packet.lane?.laneId);

  return (
    <div
      style={{
        borderRadius: 10,
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
              {packet.runtime === 'claude-code' ? 'Claude Code' : 'Codex'}
            </span>
          </span>
          <span style={{ flexShrink: 0, fontSize: 9, fontWeight: 600, color: statusMeta.color, letterSpacing: '-0.01em' }}>
            {statusMeta.label}
          </span>
          <svg width={10} height={10} viewBox="0 0 10 10" fill="none" stroke="var(--t-text-muted)" strokeWidth="1.5" strokeLinecap="round" style={{ flexShrink: 0, transform: isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 150ms ease' }}>
            <path d="M2.5 3.5L5 6L7.5 3.5" />
          </svg>
        </button>
        {canLaunch && !packet.lane ? (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onLaunch(); }}
            title="Dispatch this packet"
            style={{
              flexShrink: 0,
              border: 'none',
              background: '#2563eb',
              color: '#fff',
              padding: '4px 10px',
              borderRadius: 6,
              fontSize: 10,
              fontWeight: 700,
              cursor: 'pointer',
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
                  borderRadius: 5,
                  fontSize: 10.5,
                  fontWeight: 700,
                  cursor: canLaunch ? 'pointer' : 'default',
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
        </div>
      ) : (
        <div style={{ padding: '0 14px 8px', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 10, color: 'var(--t-text-muted)' }}>{runtimeMeta.label}</span>
          {targetLabel ? <><span style={{ fontSize: 10, color: 'var(--t-text-muted)' }}>·</span><span style={{ fontSize: 10, color: 'var(--t-text-muted)' }}>{targetLabel}</span></> : null}
          {packet.lane ? <><span style={{ fontSize: 10, color: 'var(--t-text-muted)' }}>·</span><span style={{ fontSize: 10, color: '#22c55e', fontWeight: 600 }}>Live</span></> : null}
          {packet.lane?.laneId ? <><span style={{ fontSize: 10, color: 'var(--t-text-muted)' }}>·</span><span style={{ fontSize: 10, color: 'var(--t-text-muted)', fontFamily: 'var(--font-mono, "SF Mono", Menlo, monospace)' }}>{packet.lane.laneId.slice(0, 12)}</span></> : null}
        </div>
      )}
    </div>
  );
}
