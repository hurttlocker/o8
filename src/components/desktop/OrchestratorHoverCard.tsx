'use client';

/**
 * OrchestratorHoverCard — hover a thread row that owns live worker packets and
 * this shows the fleet at a glance: thread title, repo/backend meta, then a
 * mini-list of its agents with band-toned dots and status labels.
 *
 * Pairs with the fleet reveal (SIDEBAR_HOVER_THREAD_EVENT): while this card is
 * up, the same packets are lit in the Agents section and the rest are dimmed.
 * T3's tooltip shows thread facts; ours shows the thing T3 doesn't have — the
 * orchestrator→worker relationship.
 */

import { createPortal } from 'react-dom';
import { MetaRow, resolveHoverPosition } from './SpawnedAgentHoverCard';
import { AGENT_STATUS_ACCENT } from './AgentStatusDot';
import { attentionBand, type AttentionBand } from './repo-focus/tabs/chats/sections';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { packetRuntimeModelDisplayLabel } from '@/lib/orchestrator/display';

const AGENT_LIST_CAP = 6;

function bandDotColor(band: AttentionBand): string {
  return band === 'failed'
    ? AGENT_STATUS_ACCENT.failed
    : band === 'rejected' || band === 'human'
      ? AGENT_STATUS_ACCENT.rejected
      : band === 'review'
        ? AGENT_STATUS_ACCENT.review
        : band === 'merged'
          ? AGENT_STATUS_ACCENT.merged
          : band === 'in-flight'
            ? AGENT_STATUS_ACCENT.running
            : 'var(--t-text-faint)';
}

function packetStatusLabel(status: string): string {
  const normalized = status.trim().toLowerCase();
  if (normalized === 'awaiting_human' || normalized === 'awaiting_input') return 'needs you';
  if (normalized === 'awaiting_orchestrator') return 'escalated';
  if (normalized === 'reviewing' || normalized === 'awaiting_review') return 'review ready';
  return normalized.replace(/_/g, ' ');
}

export function OrchestratorHoverCard({
  title,
  repoLabel,
  backendLabel,
  packets,
  anchorRect,
  onMouseEnter,
  onMouseLeave,
}: {
  title: string;
  repoLabel: string | null;
  backendLabel: string | null;
  packets: OrchestratorPacket[];
  anchorRect: DOMRect | null;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  if (!anchorRect || typeof document === 'undefined') return null;

  const position = resolveHoverPosition(anchorRect);
  const shown = packets.slice(0, AGENT_LIST_CAP);
  const overflow = packets.length - shown.length;

  return createPortal(
    <div
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{
        position: 'fixed',
        left: position.left,
        top: position.top,
        zIndex: 10000,
        width: 348,
        paddingTop: 14,
        paddingRight: 16,
        paddingBottom: 13,
        paddingLeft: 16,
        borderRadius: 12,
        border: '1px solid var(--t-panel-border)',
        background: 'var(--t-panel-solid)',
        boxShadow: 'var(--t-panel-shadow), 0 8px 32px rgba(15, 23, 42, 0.18)',
        color: 'var(--t-text)',
        pointerEvents: 'auto',
        fontFamily: 'var(--font-sans-system)',
      }}
    >
      <div
        style={{
          fontSize: 13.5,
          fontWeight: 300,
          letterSpacing: '-0.1px',
          lineHeight: 1.25,
          color: 'var(--t-text)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          marginBottom: 11,
        }}
        title={title}
      >
        {title}
      </div>

      <div style={{ display: 'grid', gap: 7 }}>
        {repoLabel ? <MetaRow label="Repo" value={repoLabel} /> : null}
        {backendLabel ? <MetaRow label="Backend" value={backendLabel} /> : null}
        <MetaRow label="Agents" value={`${packets.length} dispatched`} />
      </div>

      <div
        style={{
          marginTop: 12,
          paddingTop: 10,
          borderTop: '1px solid var(--t-divider-subtle)',
          display: 'grid',
          gap: 6,
        }}
      >
        {shown.map((packet) => {
          const band = attentionBand({ status: packet.status });
          return (
            <div
              key={packet.id}
              style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}
            >
              <span
                aria-hidden
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: bandDotColor(band),
                  flexShrink: 0,
                }}
              />
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: 11.5,
                  fontWeight: 300,
                  letterSpacing: '-0.1px',
                  color: 'var(--t-text-muted)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={packet.title}
              >
                {packet.title}
              </span>
              <span
                style={{
                  flexShrink: 0,
                  maxWidth: 124,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  fontSize: 9.5,
                  color: 'var(--t-text-faint)',
                  whiteSpace: 'nowrap',
                }}
                title={packetRuntimeModelDisplayLabel(packet)}
              >
                {packetRuntimeModelDisplayLabel(packet)}
              </span>
              <span
                style={{
                  flexShrink: 0,
                  fontSize: 9.5,
                  fontWeight: 260,
                  letterSpacing: '-0.4px',
                  color: bandDotColor(band),
                  whiteSpace: 'nowrap',
                }}
              >
                {packetStatusLabel(packet.status)}
              </span>
            </div>
          );
        })}
        {overflow > 0 ? (
          <div
            style={{
              fontSize: 9.5,
              fontWeight: 260,
              letterSpacing: '-0.4px',
              color: 'var(--t-text-faint)',
              paddingLeft: 14,
            }}
          >
            +{overflow} more
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
