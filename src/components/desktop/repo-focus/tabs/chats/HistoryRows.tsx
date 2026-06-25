'use client';

import { useState, type MouseEvent } from 'react';
import { CheckCircle2 } from '../../../lucide-shims';
import { formatElapsed, REPO_FOCUS_FONT } from '../../utils';
import { HISTORY_ROW_TONES } from './constants';
import {
  formatElapsedAgo,
  historySection,
  isAutomationSession,
  packetRepoLabel,
  packetTimestamp,
  shimmerTextStyle,
} from './helpers';
import { AgentStatusDot, type AgentDotState } from '@/components/desktop/AgentStatusDot';
import type { ArchivedLaneRow, ChatHistoryItem, HistoryRowTone } from './types';
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
}: {
  item: ChatHistoryItem;
  active: boolean;
  disabled: boolean;
  compact: boolean;
  tone?: HistoryRowTone | null;
  onOpen: () => void;
  onOpenMenu?: (event: MouseEvent<HTMLDivElement>) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const rowTone = active
    ? HISTORY_ROW_TONES.active
    : (tone ?? (historySection(item) === 'orchestrator' ? HISTORY_ROW_TONES.activity : HISTORY_ROW_TONES.neutral));
  const metaParts = compact ? [] : [
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
        if (!disabled) onOpen();
      }}
      onKeyDown={(event) => {
        if (disabled) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onOpen();
      }}
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
        transition: 'background 180ms ease, opacity 180ms ease',
      }}
    >
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
            // Focused-row title shimmer — flare at 95% white-ish so the
            // sweep reads against the dark base text without going blue.
            ...(active ? shimmerTextStyle('var(--t-text)', 'rgba(120, 130, 145, 0.95)') : {}),
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
        {compact ? (
          <span>{formatElapsedAgo(item.modifiedAt)}</span>
        ) : null}
        <AgentStatusDot state={dotState} />
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
      }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 13.5, lineHeight: 1.25, fontWeight: 300, letterSpacing: '-0.1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {session.name || session.runtime || 'Agent'}
        </span>
        <span style={{ display: 'block', marginTop: 4, color: 'var(--t-text-faint)', fontSize: 9.5, lineHeight: 1.25, fontWeight: 260, letterSpacing: '-0.4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {metaLabel}
        </span>
      </span>
      <AgentStatusDot state={isRunning ? 'running' : 'idle'} />
    </button>
  );
}
