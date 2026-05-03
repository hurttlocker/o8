'use client';

/**
 * O8ActivityPacketRow — packet row inside the O8 Panel Activity timeline.
 *
 * Commit 1 of the Mission rail consolidation (epic: drop the right-side
 * Mission sidebar; drive packets from the Activity tab). This row is the
 * minimum viable cut — it renders a packet inline with commits/PRs/issues
 * so the operator can FEEL whether the consolidated read is right.
 *
 * Out of scope here (lands in commit 2):
 *   - Launch / Merge / Resume buttons (still happens via Mission rail today)
 *   - Review snapshot fetch
 *   - Inline branch/runtime/repo edit
 *
 * Action wiring intentionally narrow: clicking "View in workspace" calls
 * `onSelectedPacketChange(packet.id)` which pivots the LEFT workspace pane
 * to packet mode (Spec / Agent Overview) via the existing context plumbing.
 */

import { memo, useCallback } from 'react';
import { orchestratorRuntimeTone, orchestratorStatusTone } from '@/lib/orchestrator/display';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { useOrchestratorData } from '../orchestrator-data-context';
import { relativeAge } from '../agent-panel/shared';

interface O8ActivityPacketRowProps {
  packet: OrchestratorPacket;
  isExpanded: boolean;
  onToggleExpanded: () => void;
}

function O8ActivityPacketRowBase({ packet, isExpanded, onToggleExpanded }: O8ActivityPacketRowProps) {
  const data = useOrchestratorData();
  const statusMeta = orchestratorStatusTone(packet.status);
  const runtimeMeta = orchestratorRuntimeTone(packet.runtime);
  const targetLabel = data?.workspaceTargets?.find((t) => t.localPath === packet.workspaceTargetPath)?.label
    ?? packet.workspaceTargetPath?.split('/').pop()
    ?? null;

  const ageSource = packet.lane?.lastEventAt ?? packet.lastEventAt ?? null;
  const ageLabel = ageSource ? relativeAge(ageSource) : '';

  const handleViewInWorkspace = useCallback(() => {
    data?.onSelectedPacketChange?.(packet.id);
  }, [data, packet.id]);

  return (
    <div>
      <button
        type="button"
        onClick={onToggleExpanded}
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 8,
          width: '100%',
          paddingTop: 7,
          paddingRight: 14,
          paddingBottom: 7,
          paddingLeft: 14,
          border: 'none',
          background: isExpanded ? 'rgba(37,99,235,0.06)' : 'transparent',
          cursor: 'pointer',
          textAlign: 'left',
          transition: 'background 100ms cubic-bezier(0.22, 1, 0.36, 1)',
          fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
        }}
        onMouseEnter={(e) => { if (!isExpanded) e.currentTarget.style.background = 'rgba(37,99,235,0.04)'; }}
        onMouseLeave={(e) => { if (!isExpanded) e.currentTarget.style.background = 'transparent'; }}
      >
        {/* Expand indicator */}
        <div
          style={{
            width: 10,
            height: 20,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            color: 'var(--t-text-faint)',
            transition: 'transform 150ms cubic-bezier(0.22, 1, 0.36, 1)',
            transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
          }}
        >
          <svg width="7" height="7" viewBox="0 0 7 7" fill="currentColor"><path d="M1.5 0.5L5.5 3.5L1.5 6.5Z" /></svg>
        </div>

        {/* Status dot, sized to match the existing Activity icon column */}
        <div
          style={{
            width: 20,
            height: 20,
            borderRadius: '50%',
            background: statusMeta.background,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            marginTop: 1,
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: statusMeta.color,
              boxShadow: `0 0 6px ${statusMeta.border}`,
            }}
          />
        </div>

        {/* Title + subline */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 12,
              color: 'var(--t-text)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              lineHeight: 1.4,
              fontWeight: 500,
            }}
          >
            {packet.title}
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              marginTop: 1,
              fontSize: 10,
              color: 'var(--t-text-muted)',
              fontFamily: '"SF Mono", ui-monospace, monospace',
              lineHeight: 1.4,
            }}
          >
            <span>{runtimeMeta.label}</span>
            {targetLabel ? (
              <>
                <span style={{ color: 'var(--t-text-faint)' }}>·</span>
                <span>{targetLabel}</span>
              </>
            ) : null}
            {ageLabel ? (
              <>
                <span style={{ color: 'var(--t-text-faint)' }}>·</span>
                <span>{ageLabel}</span>
              </>
            ) : null}
          </div>
        </div>

        {/* Trailing status badge */}
        <span
          style={{
            paddingTop: 1,
            paddingRight: 6,
            paddingBottom: 1,
            paddingLeft: 6,
            borderRadius: 999,
            fontSize: 9,
            fontWeight: 700,
            flexShrink: 0,
            marginTop: 4,
            background: `${statusMeta.color}1a`,
            color: statusMeta.color,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
          }}
        >
          {statusMeta.label}
        </span>
      </button>

      {isExpanded ? (
        <div
          style={{
            paddingTop: 6,
            paddingRight: 14,
            paddingBottom: 10,
            paddingLeft: 52,
            borderBottom: '1px solid var(--t-panel-border, rgba(0,0,0,0.06))',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <PacketMetaGrid packet={packet} runtimeLabel={runtimeMeta.label} targetLabel={targetLabel} />

          {packet.summary?.trim() ? (
            <div
              style={{
                fontSize: 11,
                color: 'var(--t-text-muted)',
                lineHeight: 1.55,
                fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {packet.summary.trim().slice(0, 400)}
              {packet.summary.trim().length > 400 ? '...' : ''}
            </div>
          ) : null}

          <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
            <button
              type="button"
              onClick={handleViewInWorkspace}
              disabled={!data?.onSelectedPacketChange}
              style={{
                paddingTop: 3,
                paddingRight: 10,
                paddingBottom: 3,
                paddingLeft: 10,
                borderRadius: 6,
                border: '1px solid var(--t-divider-subtle)',
                background: 'var(--t-panel)',
                color: 'var(--t-text)',
                fontSize: 10,
                fontWeight: 600,
                cursor: data?.onSelectedPacketChange ? 'pointer' : 'not-allowed',
                fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
                opacity: data?.onSelectedPacketChange ? 1 : 0.5,
              }}
            >
              View in workspace
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function PacketMetaGrid({
  packet,
  runtimeLabel,
  targetLabel,
}: {
  packet: OrchestratorPacket;
  runtimeLabel: string;
  targetLabel: string | null;
}) {
  const rows: Array<[string, string]> = [
    ['runtime', runtimeLabel],
    ['repo', targetLabel ?? '—'],
  ];
  if (packet.branchTarget) rows.push(['branch', String(packet.branchTarget)]);
  if (packet.lane?.laneId) rows.push(['lane', packet.lane.laneId.slice(0, 12)]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {rows.map(([label, value]) => (
        <div
          key={label}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 10.5,
            fontFamily: '"SF Mono", ui-monospace, monospace',
            color: 'var(--t-text-muted)',
            lineHeight: 1.5,
          }}
        >
          <span
            style={{
              width: 56,
              flexShrink: 0,
              fontSize: 9,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              color: 'var(--t-text-faint)',
              fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
            }}
          >
            {label}
          </span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {value}
          </span>
        </div>
      ))}
    </div>
  );
}

export const O8ActivityPacketRow = memo(O8ActivityPacketRowBase);
