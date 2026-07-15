'use client';

import { useRef, useState, type MouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight } from '../../../lucide-shims';
import { trackThreadDrag } from '@/lib/workspace-terminal/thread-drag';
import { formatElapsed, REPO_FOCUS_FONT } from '../../utils';
import { HISTORY_ROW_TONES } from './constants';
import {
  formatElapsedAgo,
  historySection,
  isAutomationSession,
  packetRepoLabel,
  packetStateTone,
  packetTimestamp,
  shimmerTextStyle,
} from './helpers';
import { AgentStatusDot, type AgentDotState } from '@/components/desktop/AgentStatusDot';
import type { ArchivedLaneRow, ChatHistoryItem, HistoryRowTone } from './types';
import { orchestratorBackendDisplayLabel } from '@/lib/orchestrator/display';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { IdeWorkspaceSession } from '../../types';

export function ArchivedLaneCompactRow({
  lane,
  onSelectSession,
}: {
  lane: ArchivedLaneRow;
  onSelectSession?: (sessionKey: string, hint?: { title?: string }) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const disabled = !lane.sessionKey || !onSelectSession;
  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      onClick={() => {
        if (disabled || !lane.sessionKey) return;
        onSelectSession?.(lane.sessionKey, { title: lane.label });
      }}
      onKeyDown={(event) => {
        if (disabled || !lane.sessionKey) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onSelectSession?.(lane.sessionKey, { title: lane.label });
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-disabled={disabled}
      style={{
        width: '100%',
        minHeight: 31,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        background: hovered && !disabled ? 'var(--t-hover)' : 'transparent',
        color: 'var(--t-text)',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        textAlign: 'left',
        outline: 'none',
        fontFamily: REPO_FOCUS_FONT,
        paddingTop: 5,
        paddingRight: 13,
        paddingBottom: 5,
        paddingLeft: 37,
        transition: 'background 180ms ease',
      }}
    >
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontSize: 13.5,
          fontWeight: 300,
          letterSpacing: '-0.1px',
          lineHeight: 1.25,
          color: 'var(--t-text-muted)',
        }}
      >
        {lane.label}
      </span>
      {/* Match active chat rows — timestamp + 5px static ring in a
          flex container so the ring sits at the same column as the
          ring on active chats above. No runtime brand logo; the
          Archived header tells the operator everything here is dormant. */}
      <span
        style={{
          flexShrink: 0,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          color: 'var(--t-text-faint)',
          fontSize: 9.5,
          fontWeight: 260,
          letterSpacing: '-0.4px',
        }}
      >
        <span>{formatElapsedAgo(lane.updatedAt)}</span>
        <span className="o8-static-ring" aria-hidden style={{ width: 5, height: 5 }} />
      </span>
    </div>
  );
}

export function MergedPacketRow({ packet, compact }: { packet: OrchestratorPacket; compact: boolean }) {
  const releasedAt = packetTimestamp(packet);
  const meta = releasedAt
    ? `${packetRepoLabel(packet)} · Merged · ${formatElapsedAgo(releasedAt)}`
    : `${packetRepoLabel(packet)} · Merged`;
  return (
    <div
      title={packet.title}
      style={{
        width: '100%',
        minHeight: compact ? 31 : 42,
        display: 'flex',
        alignItems: 'center',
        gap: compact ? 6 : 8,
        background: 'transparent',
        color: 'var(--t-text)',
        textAlign: 'left',
        fontFamily: REPO_FOCUS_FONT,
        paddingTop: compact ? 2 : 5,
        paddingRight: compact ? 12 : 14,
        paddingBottom: compact ? 2 : 5,
        // Align with HistoryChatRow's chat-text X (37) so merged packets
        // and active chats sit on the same vertical column.
        paddingLeft: 37,
      }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: 'block',
            fontSize: 13.5,
            lineHeight: 1.25,
            fontWeight: 300,
            letterSpacing: '-0.1px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {packet.title}
        </span>
        {!compact ? (
          <span
            style={{
              display: 'block',
              marginTop: 4,
              color: 'var(--t-text-faint)',
              fontSize: 9.5,
              lineHeight: 1.25,
              fontWeight: 260,
              letterSpacing: '-0.4px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {meta.replace(/ · Merged.*$/, '')}
          </span>
        ) : null}
      </span>
      <span
        aria-hidden
        style={{
          flexShrink: 0,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          color: '#16a34a',
          fontSize: 9.5,
          fontWeight: 260,
          letterSpacing: '-0.4px',
        }}
      >
        {releasedAt ? <span>{formatElapsedAgo(releasedAt)}</span> : null}
        <CheckCircle2 size={compact ? 13 : 14} strokeWidth={2.1} />
      </span>
    </div>
  );
}

export function HistoryChatRow({
  item,
  active,
  disabled,
  compact,
  tone,
  onOpen,
  onOpenMenu,
  ownedCount = 0,
  ownedExpanded = true,
  onToggleOwned,
}: {
  item: ChatHistoryItem;
  active: boolean;
  disabled: boolean;
  compact: boolean;
  tone?: HistoryRowTone | null;
  onOpen: () => void;
  onOpenMenu?: (event: MouseEvent<HTMLDivElement>) => void;
  /** Workers this orchestrator thread spawned (ownership nesting, Q ruling
   *  2026-07-12: variant A structure + variant B's count-as-collapse). */
  ownedCount?: number;
  ownedExpanded?: boolean;
  onToggleOwned?: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  // Drag-to-split (Claude Code parity): a pointerdown that travels past the
  // threshold becomes a workspace drag; the trailing click is suppressed so
  // a real drag never ALSO opens the thread in place.
  const dragActivatedRef = useRef(false);
  const handleDragPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return;
    dragActivatedRef.current = false;
    trackThreadDrag(
      { clientX: event.clientX, clientY: event.clientY },
      {
        threadId: item.tabId,
        title: item.title,
        mode: historySection(item) === 'orchestrator' ? 'orchestrator' : 'chat',
        repoPath: item.repoPath ?? null,
      },
      { onActivate: () => { dragActivatedRef.current = true; } },
    );
  };
  const rowTone = active
    ? HISTORY_ROW_TONES.active
    : (tone ?? (historySection(item) === 'orchestrator' ? HISTORY_ROW_TONES.activity : HISTORY_ROW_TONES.neutral));
  const metaParts = compact ? [] : [
    item.backend ? { text: orchestratorBackendDisplayLabel({ backend: item.backend, agent: item.agent }) ?? null, status: false } : null,
    rowTone.label ? { text: rowTone.label, status: true } : null,
    { text: formatElapsedAgo(item.modifiedAt), status: false },
  ].filter((part): part is { text: string; status: boolean } => Boolean(part?.text));
  const dotState: AgentDotState =
    rowTone.key === 'running' ? 'running'
      : rowTone.key === 'review' ? 'review'
        : rowTone.key === 'merged' ? 'merged'
          : rowTone.key === 'failed' ? 'failed'
            : 'idle';

  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      onClick={() => {
        if (dragActivatedRef.current) {
          dragActivatedRef.current = false;
          return;
        }
        if (!disabled) onOpen();
      }}
      onKeyDown={(event) => {
        if (disabled) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onOpen();
      }}
      onPointerDown={handleDragPointerDown}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onContextMenu={(event) => {
        event.preventDefault();
        onOpenMenu?.(event);
      }}
      aria-disabled={disabled}
      style={{
        width: '100%',
        minHeight: compact ? 31 : 42,
        display: 'flex',
        alignItems: 'center',
        gap: compact ? 6 : 8,
        background: active ? rowTone.background : hovered ? 'var(--t-hover)' : rowTone.background,
        color: 'var(--t-text)',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.72 : 1,
        textAlign: 'left',
        outline: 'none',
        fontFamily: REPO_FOCUS_FONT,
        paddingTop: 5,
        paddingRight: compact ? 12 : 14,
        paddingBottom: 5,
        // Indented to align with top-nav text X (MiniAgentPanelAction =
        // paddingLeft 12 + 17 icon + 8 gap = 37). Folder icon on repo
        // header sits at X=12, so chats nest visually under their group.
        paddingLeft: 37,
        // Gutter dot needs an anchor; visual layout unchanged otherwise.
        position: 'relative',
        transition: 'background 180ms ease, opacity 180ms ease',
      }}
    >
      {/* Status dot leads the row in the 37px indent gutter (Q 2026-07-12,
          Claude-style): you scan states down the LEFT edge before reading a
          word. Title X stays exactly 37 — the hurttlocker indent is untouched;
          the dot centers in the gutter beside it. */}
      <span
        aria-hidden
        style={{
          position: 'absolute',
          left: 14,
          top: '50%',
          transform: 'translateY(-50%)',
          display: 'inline-flex',
          alignItems: 'center',
        }}
      >
        <AgentStatusDot state={dotState} />
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          className={active ? 'o8-text-shimmer' : undefined}
          style={{
            display: 'block',
            fontSize: 13.5,
            lineHeight: 1.25,
            fontWeight: 300,
            letterSpacing: '-0.1px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            // Focused-row title shimmer — with the selection pill off, the
            // shimmer alone carries "you are here". Flare: orange on light
            // (--t-shimmer-flare), ice-white ink fallback on dark (Q 2026-07-14).
            ...(active ? shimmerTextStyle('var(--t-text)', 'var(--t-shimmer-flare, var(--t-text))') : {}),
          }}
        >
          {item.title}
        </span>
        {metaParts.length > 0 && !compact ? (
          <span
            style={{
              display: 'block',
              marginTop: 4,
              color: 'var(--t-text-faint)',
              fontSize: 9.5,
              lineHeight: 1.25,
              fontWeight: 260,
              letterSpacing: '-0.4px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {metaParts
              .filter((part) => !(part.status && rowTone.label)) // status moves to trailing slot
              .map((part, index) => (
                <span key={`${part.text}-${index}`}>
                  {index > 0 ? <span>{' · '}</span> : null}
                  <span>{part.text}</span>
                </span>
              ))}
          </span>
        ) : null}
      </span>
      {/* Trailing meta — Antigravity-style: timestamp + status indicator
          live on the right edge so the title can breathe at the left. */}
      <span
        style={{
          flexShrink: 0,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          color: 'var(--t-text-faint)',
          fontSize: 9.5,
          fontWeight: 260,
          letterSpacing: '-0.4px',
        }}
      >
        {/* Variant-B affordance: faint "N agents" count doubles as the
            per-thread collapse toggle for the nested worker rows below.
            stopPropagation — the row itself opens the chat. */}
        {compact && ownedCount > 0 && onToggleOwned ? (
          <span
            role="button"
            tabIndex={0}
            aria-expanded={ownedExpanded}
            title={`${ownedExpanded ? 'Hide' : 'Show'} ${ownedCount} spawned ${ownedCount === 1 ? 'agent' : 'agents'}`}
            onClick={(event) => {
              event.stopPropagation();
              onToggleOwned();
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              event.stopPropagation();
              onToggleOwned();
            }}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 2,
              cursor: 'pointer',
              color: 'var(--t-text-faint)',
              outline: 'none',
            }}
          >
            <span>{ownedCount} {ownedCount === 1 ? 'agent' : 'agents'}</span>
            {ownedExpanded ? <ChevronDown size={9} strokeWidth={2} /> : <ChevronRight size={9} strokeWidth={2} />}
          </span>
        ) : null}
        {compact ? (
          <span>{formatElapsedAgo(item.modifiedAt)}</span>
        ) : null}
      </span>
    </div>
  );
}

/**
 * OwnedWorkerRow — a worker packet nested under the orchestrator thread that
 * spawned it (linkage: packet.orchestratorThreadId === thread tabId). Variant
 * A of the ownership mockup (Q 2026-07-12): +7 indent from the parent text
 * column, smaller dimmer title, same 6px status-dot vocabulary — ownership
 * reads spatially, zero clicks. Click focuses the worker's lane via the same
 * event the Spawned-agents section dispatches.
 */
export function OwnedWorkerRow({ packet }: { packet: OrchestratorPacket }) {
  const [hovered, setHovered] = useState(false);
  const tone = packetStateTone(packet);
  const dotState: AgentDotState =
    tone?.key === 'running' ? 'running'
      : tone?.key === 'review' ? 'review'
        : tone?.key === 'merged' ? 'merged'
          : tone?.key === 'failed' ? 'failed'
            : 'idle';
  const timestamp = packetTimestamp(packet);
  const focusLane = () => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('o8:focus-spawned-agent-lane', {
      detail: {
        packetId: packet.id,
        sessionKey: packet.lane?.sessionKey ?? null,
        laneId: packet.lane?.laneId ?? null,
        title: packet.title,
      },
    }));
  };
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={focusLane}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        focusLane();
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: '100%',
        minHeight: 26,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        background: hovered ? 'var(--t-hover)' : 'transparent',
        color: 'var(--t-text-muted)',
        cursor: 'pointer',
        textAlign: 'left',
        outline: 'none',
        fontFamily: REPO_FOCUS_FONT,
        paddingTop: 4,
        paddingRight: 12,
        paddingBottom: 4,
        // Parent thread title sits at x=37; workers nest exactly +7 (the
        // locked repo-child indent step). Dot centers in the gutter beside.
        paddingLeft: 44,
        position: 'relative',
        transition: 'background 180ms ease',
      }}
    >
      <span
        aria-hidden
        style={{
          position: 'absolute',
          left: 21,
          top: '50%',
          transform: 'translateY(-50%)',
          display: 'inline-flex',
          alignItems: 'center',
        }}
      >
        <AgentStatusDot state={dotState} />
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 12,
          lineHeight: 1.25,
          fontWeight: 300,
          letterSpacing: '-0.1px',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {packet.title}
      </span>
      {timestamp ? (
        <span
          style={{
            flexShrink: 0,
            color: 'var(--t-text-faint)',
            fontSize: 9.5,
            fontWeight: 260,
            letterSpacing: '-0.4px',
          }}
        >
          {formatElapsedAgo(timestamp)}
        </span>
      ) : null}
    </div>
  );
}

export function CompactSessionRow({
  session,
  onSelectSession,
}: {
  session: IdeWorkspaceSession;
  onSelectSession?: (sessionKey: string) => void;
}) {
  const automation = isAutomationSession(session);
  const metaLabel = automation
    ? `${session.branch || 'workspace'} · automation · ${session.status}`
    : `${session.branch || 'workspace'} · ${formatElapsed(session.lastActivityAt ?? session.lastEventAt)} idle`;
  // Motion vocabulary: running → pulse (B), anything else → ring (A) since
  // the row only renders for live sessions in the first place ("alive").
  const isRunning = (session.status ?? '').toLowerCase() === 'running';
  return (
    <button
      type="button"
      onClick={() => onSelectSession?.(session.sessionKey)}
      style={{
        width: '100%',
        minHeight: 36,
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        borderWidth: 0,
        background: 'transparent',
        color: 'var(--t-text)',
        cursor: 'pointer',
        textAlign: 'left',
        outline: 'none',
        fontFamily: REPO_FOCUS_FONT,
        paddingTop: 4,
        paddingRight: 12,
        paddingBottom: 4,
        paddingLeft: 37,
        position: 'relative',
      }}
    >
      {/* Left-gutter status dot — same treatment as HistoryRow (Q 2026-07-12). */}
      <span
        aria-hidden
        style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', display: 'inline-flex', alignItems: 'center' }}
      >
        <AgentStatusDot state={isRunning ? 'running' : 'idle'} />
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 13.5, lineHeight: 1.25, fontWeight: 300, letterSpacing: '-0.1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {session.name || session.runtime || 'Agent'}
        </span>
        <span style={{ display: 'block', marginTop: 4, color: 'var(--t-text-faint)', fontSize: 9.5, lineHeight: 1.25, fontWeight: 260, letterSpacing: '-0.4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {metaLabel}
        </span>
      </span>
    </button>
  );
}
