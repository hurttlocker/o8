'use client';

import { useCallback, useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { AgentStatusDot, type AgentDotState } from '@/components/desktop/AgentStatusDot';
import { formatElapsedAgo } from './repo-focus/tabs/chats/helpers';
import { attentionWashStyle } from './repo-focus/tabs/chats/HistoryRows';
import { shouldRecede, type AttentionBand } from './repo-focus/tabs/chats/sections';

export type AgentOrigin = 'CLI' | 'MCP' | 'Mobile' | 'Webhook' | 'Cloud';
export type VisualStatus = 'running' | 'waiting' | 'idle' | 'error' | 'archived';
export type LaneStatus = 'idle' | 'launching' | 'running' | 'paused' | 'awaiting_input' | 'awaiting_human' | 'awaiting_orchestrator' | 'recovering' | 'reviewing' | 'merging' | 'failed' | 'completed' | 'merged' | 'released' | 'archived';

export interface ExtraAgentRow {
  key: string;
  origin: AgentOrigin;
  status: VisualStatus;
  runtime: string;
  name: string;
  subtitle: string;
  lastActivityAt: number;
  sessionKey: string | null;
  repoPath: string | null;
  packetId: string | null;
  laneId: string | null;
  laneStatus: LaneStatus | null;
  outcome: 'no_changes' | 'merged' | 'discarded' | 'pr_opened' | 'asked' | null;
  outcomeNote: string | null;
  lastEventLabel: string | null;
  /** Open PR for this lane, surfaced in the hover card (T3 keeps it in-row —
   *  too cramped; ours lives one hover away). */
  prNumber?: number | null;
  /** Latest review verdict was a rejection — drives the 'rejected' dot so the
   *  sidebar agrees with the decision banner (which reads the same verdict).
   *  Detachment-proof: derived from durable approvals, not the lane status. */
  rejected?: boolean;
}

export interface ExtraAgentActionMenuState {
  x: number;
  y: number;
  row: ExtraAgentRow;
}

const FONT = 'var(--font-sans-system)';

function OriginChip({ origin }: { origin: AgentOrigin }) {
  if (origin === 'CLI') return null;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        paddingTop: 1,
        paddingBottom: 1,
        paddingLeft: 5,
        paddingRight: 5,
        borderRadius: 4,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-border-subtle)',
        fontSize: 9,
        fontWeight: 300,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        color: 'var(--t-text-muted)',
        fontFamily: FONT,
        position: 'relative',
      }}
    >
      {origin}
    </span>
  );
}

function rowDotState(row: ExtraAgentRow): AgentDotState {
  const lane = row.laneStatus;
  if (row.outcome === 'merged') return 'merged';
  if (row.outcome === 'no_changes' || row.outcome === 'discarded' || row.outcome === 'pr_opened' || row.outcome === 'asked') return 'idle';
  // 'merged'/'released' are real lane terminal states (the DB carries them) —
  // they were missing here, so a merged packet's row kept the reviewing dot
  // (operator report 2026-07-15).
  if (lane === 'completed' || lane === 'merged' || lane === 'released') return 'merged';
  if (lane === 'failed' || lane === 'recovering') return 'failed';
  if (lane === 'archived') return 'idle';
  // A declined review reads as 'rejected' — checked before the generic review
  // dot so a reviewing lane whose verdict came back NO shows the rejected mark,
  // matching the banner instead of a fresh awaiting-review sweep.
  if (row.rejected) return 'rejected';
  if (row.status === 'running') return 'running';
  if (row.status === 'waiting') return 'review';
  if (row.status === 'error') return 'failed';
  return 'idle';
}

function rowStatusLabel(row: ExtraAgentRow): string {
  const lane = row.laneStatus;
  if (row.outcome === 'merged') return 'merged';
  if (row.outcome === 'no_changes') return 'Finished — no changes';
  if (row.outcome === 'discarded') return 'discarded';
  if (row.outcome === 'pr_opened') return 'PR open';
  if (row.outcome === 'asked') return 'asked';
  if (row.rejected) return 'declined';
  if (lane === 'reviewing') return row.lastEventLabel === 'pr_created' ? 'PR open' : 'review ready';
  if (lane === 'awaiting_input') return 'needs input';
  if (lane === 'awaiting_human') return 'needs you';
  if (lane === 'awaiting_orchestrator') return 'escalated';
  if (lane === 'failed' || lane === 'recovering') return 'failed';
  if (lane === 'archived') return 'archived';
  if (lane === 'completed' || lane === 'merged' || lane === 'released') return 'merged';
  if (lane === 'launching' || lane === 'running' || lane === 'merging') return 'running';
  if (lane === 'paused' || lane === 'idle') return 'idle';
  if (row.status === 'running') return 'running';
  if (row.status === 'waiting') return 'review ready';
  if (row.status === 'error') return 'failed';
  return row.status === 'archived' ? 'archived' : 'idle';
}

export function canArchiveExtraAgent(row: ExtraAgentRow): boolean {
  if (row.sessionKey) return true;
  if (!row.laneId) return false;
  return row.laneStatus === 'failed'
    || row.laneStatus === 'completed'
    || row.laneStatus === 'archived';
}

export function ExtraAgentRowView({
  row,
  active,
  onSelectSession,
  onFocusRow,
  onOpenMenu,
  onOpenHoverCard,
  onCloseHoverCard,
  busy,
  onRetryPacket,
  band,
  repoLabel,
  link,
}: {
  row: ExtraAgentRow;
  active: boolean;
  onSelectSession?: (sessionKey: string) => void;
  onFocusRow?: (row: ExtraAgentRow) => void;
  onOpenMenu?: (event: ReactMouseEvent, row: ExtraAgentRow) => void;
  onOpenHoverCard?: (row: ExtraAgentRow, rect: DOMRect) => void;
  onCloseHoverCard?: () => void;
  busy: boolean;
  onRetryPacket?: (row: ExtraAgentRow) => void;
  band: AttentionBand;
  repoLabel?: string | null;
  /** Fleet reveal (orchestrator thread hovered): 'linked' = this agent belongs
   *  to the hovered thread (full ink + lit), 'dimmed' = it doesn't (faint ink,
   *  wash suppressed). null/undefined = no link active. */
  link?: 'linked' | 'dimmed' | null;
}) {
  const dotState = rowDotState(row);
  const dotLabel = rowStatusLabel(row);
  const canFocus = Boolean((row.packetId || row.sessionKey || row.laneId) && (onFocusRow || onSelectSession));
  const canRetry = Boolean(row.packetId && onRetryPacket && (row.laneStatus === 'failed' || row.laneStatus === 'recovering'));
  const canInteract = canFocus || canRetry;
  const [hovered, setHovered] = useState(false);
  const recede = link === 'linked'
    ? false
    : link === 'dimmed'
      ? true
      : shouldRecede({ band, active, hovered });
  // Linked rows with no band wash (in-flight/settled) still get the neutral
  // hover-layer fill so the whole fleet visibly lights up; dimmed rows drop
  // their wash entirely — attention lives with the hovered thread's agents.
  const bandWash = attentionWashStyle(band);
  const washStyle = link === 'dimmed'
    ? null
    : link === 'linked'
      ? bandWash ?? {
        position: 'absolute' as const,
        top: 2,
        right: 6,
        bottom: 2,
        left: 6,
        borderRadius: 8,
        background: 'var(--t-hover)',
        zIndex: 0,
      }
      : bandWash;
  const handleClick = useCallback(() => {
    if (onFocusRow) {
      onFocusRow(row);
      return;
    }
    if (row.sessionKey) onSelectSession?.(row.sessionKey);
  }, [onFocusRow, onSelectSession, row]);

  return (
    <button
      type="button"
      disabled={!canInteract}
      onClick={handleClick}
      onContextMenu={(event) => {
        event.preventDefault();
        onOpenMenu?.(event, row);
      }}
      aria-current={active ? 'true' : undefined}
      title={canFocus ? `Focus ${row.name}` : row.name}
      style={{
        width: '100%',
        minHeight: 31,
        paddingTop: 5,
        paddingBottom: 5,
        paddingLeft: 37,
        paddingRight: 12,
        borderWidth: 0,
        // EXPERIMENT (Q 2026-07-14): no active-row pill — the ShinyText title
        // shimmer alone marks the selection (was 'var(--t-input-bg)'); matches
        // HISTORY_ROW_TONES.active in chats/constants.ts — revert both together.
        background: 'transparent',
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        textAlign: 'left',
        cursor: canInteract ? 'pointer' : 'default',
        fontFamily: FONT,
        // Anchor for the left-gutter status dot below — same treatment as
        // HistoryRow/CompactSessionRow (Q ruling 2026-07-12: status icons
        // sit LEFT of every sidebar row, like Claude's panel).
        position: 'relative',
        isolation: 'isolate',
      }}
      onMouseEnter={(event) => {
        setHovered(true);
        onOpenHoverCard?.(row, event.currentTarget.getBoundingClientRect());
      }}
      onMouseLeave={() => {
        setHovered(false);
        onCloseHoverCard?.();
      }}
    >
      {(active || hovered || washStyle) ? (
        <span
          aria-hidden
          style={{
            ...(washStyle ?? {}),
            ...(active || hovered ? {
              position: 'absolute',
              top: 2,
              right: 6,
              bottom: 2,
              left: 6,
              borderRadius: 8,
              background: active ? 'var(--t-input-bg)' : 'var(--t-hover)',
              zIndex: 0,
            } : {}),
          }}
        />
      ) : null}
      {/* Status dot in the absolute left gutter — matches HistoryRows so the
          whole sidebar reads one vocabulary: state left, metadata right. */}
      <span
        aria-hidden
        style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', display: 'inline-flex', alignItems: 'center' }}
      >
        <AgentStatusDot state={dotState} label={dotLabel} />
      </span>
      <span
        style={{
          flex: 1,
          // Title keeps a readable floor — the trailing outcome label shrinks
          // first (see maxWidth below). Without this, "Finished — no changes"
          // crushed titles to 5 chars at sidebar width (rig finding 2026-07-31).
          minWidth: 90,
          fontSize: 13.5,
          fontWeight: 300,
          color: link === 'dimmed'
            ? 'var(--t-text-faint)'
            : recede ? 'var(--t-text-muted)' : 'var(--t-text)',
          letterSpacing: '-0.1px',
          transition: 'color 140ms ease',
          lineHeight: 1.25,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          position: 'relative',
        }}
      >
        {row.name}
        {row.subtitle ? (
          <span
            style={{
              marginLeft: 6,
              fontSize: 9.5,
              color: active ? 'inherit' : 'var(--t-text-muted)',
              fontWeight: 260,
              letterSpacing: '-0.4px',
            }}
          >
            {row.subtitle}
          </span>
        ) : null}
        {repoLabel ? (
          <span
            style={{
              marginLeft: 6,
              fontSize: 9.5,
              color: 'var(--t-text-faint)',
              fontWeight: 260,
              letterSpacing: '-0.4px',
            }}
          >
            {repoLabel}
          </span>
        ) : null}
      </span>
      <OriginChip origin={row.origin} />
      {row.outcome ? (
        <span
          style={{
            flexShrink: 1,
            minWidth: 0,
            maxWidth: 120,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            color: row.outcome === 'merged'
              ? 'var(--t-terminal-ansi-bright-green, #16a34a)'
              : 'var(--t-text-muted)',
            fontSize: 9.5,
            fontWeight: 300,
            letterSpacing: '-0.3px',
            whiteSpace: 'nowrap',
            position: 'relative',
          }}
        >
          {row.outcome === 'merged'
            ? 'Merged'
            : row.outcome === 'no_changes'
              ? 'Finished — no changes'
              : row.outcome === 'discarded'
                ? 'Discarded'
                : row.outcome === 'pr_opened'
                  ? 'PR open'
                  : 'Asked'}
        </span>
      ) : null}
      {canRetry ? (
        <span
          title="Retry failed packet"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            if (busy) return;
            onRetryPacket?.(row);
          }}
          style={{
            minHeight: 22,
            borderRadius: 7,
            paddingTop: 0,
            paddingRight: 7,
            paddingBottom: 0,
            paddingLeft: 7,
            display: 'inline-flex',
            alignItems: 'center',
            background: 'transparent',
            color: busy ? 'var(--t-text-faint)' : 'var(--t-text-muted)',
            cursor: busy ? 'default' : 'pointer',
            fontFamily: FONT,
            fontSize: 10.5,
            fontWeight: 300,
            letterSpacing: '-0.1px',
            opacity: hovered ? 1 : 0,
            pointerEvents: hovered ? 'auto' : 'none',
            transition: 'opacity 120ms ease, background 120ms ease, color 120ms ease',
            flexShrink: 0,
            position: 'relative',
          }}
          onMouseEnter={(event) => {
            if (busy) return;
            event.currentTarget.style.background = 'var(--t-hover)';
            event.currentTarget.style.color = 'var(--t-text)';
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.background = 'transparent';
            event.currentTarget.style.color = busy ? 'var(--t-text-faint)' : 'var(--t-text-muted)';
          }}
        >
          {busy ? 'Retrying' : 'Retry'}
        </span>
      ) : null}
      {/* Trailing relative age — same meta treatment as the chat history
          rows above (Q ruling 2026-07-12: spawned agents carry the time
          too). Hidden while hovered so it never fights the Retry action. */}
      {row.lastActivityAt > 0 && !(canRetry && hovered) ? (
        <span
          style={{
            flexShrink: 0,
            color: 'var(--t-text-faint)',
            fontSize: 9.5,
            fontWeight: 260,
            letterSpacing: '-0.4px',
            position: 'relative',
          }}
        >
          {formatElapsedAgo(new Date(row.lastActivityAt).toISOString())}
        </span>
      ) : null}
    </button>
  );
}

export function ExtraAgentActionMenu({
  state,
  busy,
  canFocus,
  onClose,
  onFocus,
  onArchive,
}: {
  state: ExtraAgentActionMenuState;
  busy: boolean;
  canFocus: boolean;
  onClose: () => void;
  onFocus: () => void;
  onArchive: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const menuWidth = 190;
  const menuHeight = 130;
  const panelRect = typeof document === 'undefined'
    ? null
    : document.querySelector('[data-o8-agent-panel="true"]')?.getBoundingClientRect() ?? null;
  const viewportWidth = typeof window === 'undefined' ? 1200 : window.innerWidth;
  const viewportHeight = typeof window === 'undefined' ? 800 : window.innerHeight;
  const boundaryLeft = panelRect?.left ?? 0;
  const boundaryRight = panelRect?.right ?? viewportWidth;
  const boundaryTop = panelRect?.top ?? 0;
  const boundaryBottom = panelRect?.bottom ?? viewportHeight;
  const minLeft = boundaryLeft + 8;
  const maxLeft = Math.max(minLeft, boundaryRight - menuWidth - 8);
  const left = Math.min(Math.max(state.x, minLeft), maxLeft);
  const minTop = boundaryTop + 8;
  const maxTop = Math.max(minTop, boundaryBottom - menuHeight - 8);
  const top = Math.min(Math.max(state.y, minTop), maxTop);

  return (
    <>
      <button
        type="button"
        aria-label="Close spawned agent action menu"
        onClick={onClose}
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          left: 0,
          zIndex: 58,
          borderWidth: 0,
          background: 'transparent',
          cursor: 'default',
        }}
      />
      <div
        style={{
          position: 'fixed',
          left,
          top,
          zIndex: 59,
          width: menuWidth,
          borderRadius: 13,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: 'var(--t-divider-subtle)',
          background: 'var(--t-bg-card)',
          boxShadow: 'var(--t-panel-shadow)',
          backdropFilter: 'blur(18px) saturate(145%)',
          WebkitBackdropFilter: 'blur(18px) saturate(145%)',
          paddingTop: 7,
          paddingRight: 7,
          paddingBottom: 7,
          paddingLeft: 7,
          color: 'var(--t-text)',
        }}
      >
        <div style={{ paddingTop: 4, paddingRight: 7, paddingBottom: 7, paddingLeft: 7 }}>
          <div style={{ fontSize: 11.25, lineHeight: '15px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {state.row.name}
          </div>
          <div style={{ marginTop: 1, color: 'var(--t-text-faint)', fontSize: 10, lineHeight: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {state.row.subtitle || state.row.runtime}
          </div>
        </div>
        <div style={{ display: 'grid', gap: 2 }}>
          <ExtraAgentMenuRow label="Open" disabled={!canFocus || busy} onClick={onFocus} />
          <ExtraAgentMenuRow label="Archive" disabled={busy || !canArchiveExtraAgent(state.row)} onClick={onArchive} />
        </div>
      </div>
    </>
  );
}

function ExtraAgentMenuRow({
  label,
  disabled = false,
  onClick,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      style={{
        width: '100%',
        minHeight: 29,
        borderRadius: 9,
        borderWidth: 0,
        background: 'transparent',
        color: disabled ? 'var(--t-text-faint)' : 'var(--t-text-muted)',
        cursor: disabled ? 'default' : 'pointer',
        textAlign: 'left',
        paddingTop: 0,
        paddingRight: 9,
        paddingBottom: 0,
        paddingLeft: 9,
        fontSize: 11.25,
        lineHeight: '15px',
        fontWeight: 300,
        transition: 'background 120ms ease, color 120ms ease',
      }}
      onMouseEnter={(event) => {
        if (disabled) return;
        event.currentTarget.style.background = 'var(--t-hover)';
        event.currentTarget.style.color = 'var(--t-text)';
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.background = 'transparent';
        event.currentTarget.style.color = disabled ? 'var(--t-text-faint)' : 'var(--t-text-muted)';
      }}
    >
      {label}
    </button>
  );
}
