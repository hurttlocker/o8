'use client';

import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { CheckCircle2, Folder } from '../../../lucide-shims';
import { GitBranch } from '@/components/desktop/tabler-shims';
import { trackThreadDrag } from '@/lib/workspace-terminal/thread-drag';
import { formatElapsed, REPO_FOCUS_FONT } from '../../utils';
import { HISTORY_ROW_TONES } from './constants';
import {
  formatElapsedAgo,
  historySection,
  isAutomationSession,
  packetRepoLabel,
  packetTimestamp,
} from './helpers';
import { AGENT_STATUS_ACCENT, AgentStatusDot, type AgentDotState } from '@/components/desktop/AgentStatusDot';
import type { ArchivedLaneRow, ChatHistoryItem, HistoryRowTone } from './types';
import type { AttentionBand } from './sections';
import { orchestratorBackendDisplayLabel } from '@/lib/orchestrator/display';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { IdeWorkspaceSession } from '../../types';

// 'human' rides the warm rejected accent, NOT the slate review tone — rank 3
// ("agent blocked on you") washed in gray reads as a hover state and vanishes
// next to finished rows (rig finding 2026-07-31). Slate stays for review:
// quieter is correct one rank down. Hierarchy: red > orange > slate > green.
export function attentionAccent(band: AttentionBand): string | null {
  return band === 'failed'
    ? AGENT_STATUS_ACCENT.failed
    : band === 'rejected' || band === 'human'
      ? AGENT_STATUS_ACCENT.rejected
      : band === 'review'
        ? AGENT_STATUS_ACCENT.review
        : band === 'merged'
          ? AGENT_STATUS_ACCENT.merged
          : null;
}

export function attentionWashStyle(band: AttentionBand): CSSProperties | null {
  const accent = attentionAccent(band);
  if (!accent) return null;
  return {
    position: 'absolute',
    top: 2,
    right: 6,
    bottom: 2,
    left: 6,
    borderRadius: 8,
    background: `color-mix(in srgb, ${accent} 10%, transparent)`,
    zIndex: 0,
  };
}

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
        paddingRight: 12,
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
  repoLabel,
  branchLabel,
  recede = false,
  washBand,
  onHoverChange,
}: {
  item: ChatHistoryItem;
  active: boolean;
  disabled: boolean;
  compact: boolean;
  tone?: HistoryRowTone | null;
  onOpen: () => void;
  onOpenMenu?: (event: MouseEvent<HTMLDivElement>) => void;
  /** Static count only; worker rows live in the flat Agents section. */
  ownedCount?: number;
  repoLabel?: string | null;
  branchLabel?: string | null;
  recede?: boolean;
  washBand?: AttentionBand | null;
  /** Fleet-reveal hook: rect on enter, null on leave. Wired only for threads
   *  that own live packets — see ChatsTab. */
  onHoverChange?: (rect: DOMRect | null) => void;
}) {
  const [hovered, setHovered] = useState(false);
  // Drag-to-split (Claude Code parity): a pointerdown that travels past the
  // threshold becomes a workspace drag; the trailing click is suppressed so
  // a real drag never ALSO opens the thread in place.
  const dragActivatedRef = useRef(false);
  const dragDisposeRef = useRef<(() => void) | null>(null);
  // If the row unmounts mid-drag (list refresh under the pointer), cancel the
  // tracker explicitly instead of waiting for the next global pointerup.
  useEffect(() => () => {
    dragDisposeRef.current?.();
    dragDisposeRef.current = null;
  }, []);
  const handleDragPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return;
    dragActivatedRef.current = false;
    dragDisposeRef.current?.();
    dragDisposeRef.current = trackThreadDrag(
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
  const backendLabel = !compact && item.backend
    ? orchestratorBackendDisplayLabel({ backend: item.backend, agent: item.agent })
    : null;
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
      onMouseEnter={(event) => {
        setHovered(true);
        onHoverChange?.(event.currentTarget.getBoundingClientRect());
      }}
      onMouseLeave={() => {
        setHovered(false);
        onHoverChange?.(null);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onOpenMenu?.(event);
      }}
      aria-disabled={disabled}
      style={{
        width: '100%',
        minHeight: 39,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        // Selection + hover both paint on the rounded inset layer below —
        // the row itself stays transparent so the fill never hits the rail's
        // edges sharp (Q ruling 2026-07-16: rounded selector, no shimmer).
        background: 'transparent',
        color: 'var(--t-text)',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.72 : 1,
        textAlign: 'left',
        outline: 'none',
        fontFamily: REPO_FOCUS_FONT,
        paddingTop: 3,
        paddingRight: 12,
        paddingBottom: 3,
        // Indented to align with top-nav text X (MiniAgentPanelAction =
        // paddingLeft 12 + 17 icon + 8 gap = 37). Folder icon on repo
        // header sits at X=12, so chats nest visually under their group.
        paddingLeft: 37,
        // Gutter dot needs an anchor; visual layout unchanged otherwise.
        position: 'relative',
        transition: 'background 180ms ease, opacity 180ms ease',
      }}
    >
      {/* Rounded selection/hover layer (Q ruling 2026-07-16): the selected
          chat gets a soft rounded fill — var(--t-input-bg), the same active
          vocabulary as the workspace tab pill — readable in light AND dark,
          glass AND solid, replacing the 07-14 title-shimmer experiment
          (invisible in light mode). Hover shares the geometry with the
          lighter var(--t-hover) fill so sibling states stay cohesive. Inset
          so the fill never touches the rail edges; text X stays exactly 37
          (the hurttlocker indent is untouched — this layer is behind it). */}
      {(active || hovered || washBand) ? (
        <span
          aria-hidden
          style={{
            ...(attentionWashStyle(washBand ?? 'neutral') ?? {}),
            ...(active || hovered ? {
              position: 'absolute',
              top: 2,
              right: 4,
              bottom: 2,
              left: 4,
              borderRadius: 9,
              background: active ? 'var(--t-input-bg)' : 'var(--t-hover)',
              zIndex: 0,
            } : {}),
          }}
        />
      ) : null}
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
      <span style={{ flex: 1, minWidth: 0, position: 'relative' }}>
        <span
          style={{
            display: 'block',
            fontSize: 13.5,
            lineHeight: 1.25,
            fontWeight: 300,
            letterSpacing: '-0.1px',
            color: recede && !active && !hovered ? 'var(--t-text-muted)' : 'var(--t-text)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {item.title}
        </span>
        {(repoLabel || branchLabel || backendLabel) ? (
          <span
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              marginTop: 2,
              color: 'var(--t-text-faint)',
              fontSize: 9.5,
              lineHeight: 1.1,
              fontWeight: 260,
              letterSpacing: '-0.4px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {repoLabel ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
                <Folder size={10} strokeWidth={1.7} style={{ flexShrink: 0 }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{repoLabel}</span>
              </span>
            ) : null}
            {branchLabel ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, minWidth: 0 }}>
                <GitBranch size={10} strokeWidth={1.7} style={{ flexShrink: 0 }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{branchLabel}</span>
              </span>
            ) : null}
            {backendLabel ? <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{backendLabel}</span> : null}
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
          // Above the rounded selection layer (positioned siblings stack in
          // DOM order; unpositioned content would paint beneath it).
          position: 'relative',
        }}
      >
        {compact && ownedCount > 0 ? (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              color: 'var(--t-text-faint)',
            }}
          >
            <span>{ownedCount} {ownedCount === 1 ? 'agent' : 'agents'}</span>
          </span>
        ) : null}
        <span>{formatElapsedAgo(item.modifiedAt)}</span>
      </span>
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
