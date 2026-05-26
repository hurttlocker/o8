'use client';

import { useState, type MouseEvent } from 'react';
import { ClaudeIcon, CodexIcon, GeminiIcon, OpenCodeIcon } from '@/components/desktop/repo-registry/shared';
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
import { RuntimeHistoryIcon } from './shared';
import type { ArchivedLaneRow, ChatHistoryItem, HistoryRowTone } from './types';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { IdeWorkspaceSession } from '../../types';

// Merged-state glyph — Claude-style purple branch-merge mark. Static (no
// animation) so it sits quietly alongside the gray rings, but the color
// breaks the gray rhythm enough to catch the eye on a long list. Sized
// to match the 5px ring footprint so the row alignment stays clean.
function MergedGlyph() {
  return (
    <span
      aria-label="Merged"
      title="Merged"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 9,
        height: 9,
        flexShrink: 0,
        color: '#8b5cf6',
      }}
    >
      <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <circle cx="3" cy="3" r="1.5" />
        <circle cx="3" cy="9" r="1.5" />
        <circle cx="9" cy="6" r="1.5" />
        <path d="M3 4.5v3" />
        <path d="M4.5 3c0 1.5 1.5 3 3 3" />
      </svg>
    </span>
  );
}

export function ArchivedLaneCompactRow({
  lane,
  onSelectSession,
}: {
  lane: ArchivedLaneRow;
  onSelectSession?: (sessionKey: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const disabled = !lane.sessionKey || !onSelectSession;
  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      onClick={() => {
        if (disabled || !lane.sessionKey) return;
        onSelectSession?.(lane.sessionKey);
      }}
      onKeyDown={(event) => {
        if (disabled || !lane.sessionKey) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onSelectSession?.(lane.sessionKey);
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
        paddingTop: 2,
        paddingRight: 10,
        paddingBottom: 2,
        paddingLeft: 10,
        transition: 'background 180ms ease',
      }}
    >
      <span
        aria-hidden
        style={{
          width: 16,
          height: 16,
          borderRadius: 5,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          color: 'var(--t-text-muted)',
        }}
      >
        {lane.runtime === 'claude-code' ? (
          <ClaudeIcon size={12} />
        ) : lane.runtime === 'gemini' ? (
          <GeminiIcon size={12} />
        ) : lane.runtime === 'opencode' ? (
          <OpenCodeIcon size={12} />
        ) : (
          <CodexIcon size={12} />
        )}
      </span>
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
        paddingRight: compact ? 10 : 12,
        paddingBottom: compact ? 2 : 5,
        paddingLeft: compact ? 10 : 12,
      }}
    >
      <span
        aria-hidden
        style={{
          width: compact ? 16 : 20,
          height: compact ? 16 : 20,
          borderRadius: compact ? 5 : 6,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          color: '#16a34a',
        }}
      >
        <CheckCircle2 size={compact ? 13 : 14} strokeWidth={2.1} />
      </span>
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
          {meta}
        </span>
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
  const shimmerStatus = rowTone.key === 'running' || rowTone.key === 'review';
  const mergedStatus = rowTone.key === 'merged';

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
        paddingRight: compact ? 10 : 12,
        paddingBottom: 5,
        paddingLeft: compact ? 10 : 12,
        transition: 'background 180ms ease, opacity 180ms ease',
      }}
    >
      {shimmerStatus ? (
        // Motion vocab B — chat has an active running/reviewing packet.
        <span className="o8-pulse-circle" aria-label="Agent working" title="Agent working" />
      ) : mergedStatus ? (
        // Motion vocab: merged → distinctive purple branch glyph that
        // catches the eye against the gray rings everywhere else.
        <MergedGlyph />
      ) : (
        // Motion vocab A — every idle chat carries the tiny ring so the
        // pulse / merged glyph reads as a state change against a baseline.
        <span className="o8-static-ring" aria-hidden style={{ width: 5, height: 5 }} />
      )}
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
        {metaParts.length > 0 ? (
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
            {metaParts.map((part, index) => (
              <span key={`${part.text}-${index}`}>
                {index > 0 ? <span>{' · '}</span> : null}
                <span
                  className={part.status && shimmerStatus ? 'o8-text-shimmer' : undefined}
                  style={part.status ? {
                    color: rowTone.iconColor,
                    fontWeight: 650,
                    ...(shimmerStatus ? shimmerTextStyle(rowTone.iconColor, 'var(--t-text)') : {}),
                  } : undefined}
                >
                  {part.text}
                </span>
              </span>
            ))}
          </span>
        ) : null}
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
        paddingRight: 10,
        paddingBottom: 4,
        paddingLeft: 10,
      }}
    >
      {isRunning ? (
        <span className="o8-pulse-circle" aria-label="Working" title="Working" style={{ width: 5, height: 5 }} />
      ) : (
        <span className="o8-static-ring" aria-label="Idle session" title="Idle session" style={{ width: 5, height: 5 }} />
      )}
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
