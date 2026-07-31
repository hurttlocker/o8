'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { deriveSpawnedAgentState, formatSpawnedAgentElapsed } from './spawned-agents-hover-card-utils';
import type { ExtraAgentRow } from './AgentPanelExtraAgentRow';
import type { TranscriptEvent } from '@/lib/orchestrator/transcript-normalizer';

interface SpawnedAgentHoverCardProps {
  row: ExtraAgentRow;
  anchorRect: DOMRect | null;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

interface HoverTranscript {
  status: 'loading' | 'loaded' | 'unavailable';
  lastMessage: string | null;
  lastActivity: string | null;
}

const CARD_WIDTH = 348;
const CARD_HEIGHT_ESTIMATE = 242;

export function resolveHoverPosition(anchorRect: DOMRect) {
  const viewportWidth = typeof window === 'undefined' ? 1440 : window.innerWidth;
  const viewportHeight = typeof window === 'undefined' ? 900 : window.innerHeight;
  const margin = 14;
  let left = anchorRect.right + 14;
  if (left + CARD_WIDTH + margin > viewportWidth) {
    left = Math.max(margin, anchorRect.left - CARD_WIDTH - 14);
  }
  let top = anchorRect.top - 4;
  if (top + CARD_HEIGHT_ESTIMATE + margin > viewportHeight) {
    top = Math.max(margin, viewportHeight - CARD_HEIGHT_ESTIMATE - margin);
  }
  return { left, top };
}

export function MetaRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, minWidth: 0 }}>
      <div
        style={{
          width: 54,
          flexShrink: 0,
          fontSize: 9.5,
          fontWeight: 260,
          letterSpacing: '-0.4px',
          color: 'var(--t-text-faint)',
        }}
      >
        {label}
      </div>
      <div
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
      >
        {value}
      </div>
    </div>
  );
}

// Pull the freshest human-readable signal out of the transcript tail: the last
// assistant text is "what the agent last said"; the last tool call/result
// summary is "what it's doing right now" (often newer than the last message).
function summarizeTranscriptTail(events: TranscriptEvent[]): { lastMessage: string | null; lastActivity: string | null } {
  let lastMessage: string | null = null;
  let lastActivity: string | null = null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (!event) continue;
    if (!lastMessage && event.type === 'assistant' && event.text.trim()) {
      lastMessage = event.text.trim();
    }
    if (!lastActivity) {
      if (event.type === 'tool_call' || event.type === 'tool_result') lastActivity = event.summary;
      else if (event.type === 'error') lastActivity = event.message;
      else if (event.type === 'done') lastActivity = event.exitCode === 0 ? 'Finished (exit 0)' : `Exited with code ${event.exitCode}`;
    }
    if (lastMessage && lastActivity) break;
  }
  return { lastMessage, lastActivity };
}

export function SpawnedAgentHoverCard({
  row,
  anchorRect,
  onMouseEnter,
  onMouseLeave,
}: SpawnedAgentHoverCardProps) {
  const [now, setNow] = useState(() => Date.now());
  const [transcript, setTranscript] = useState<HoverTranscript>({ status: 'loading', lastMessage: null, lastActivity: null });

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    // One tail fetch per hovered row — a hover is transient, so no poll. The
    // sessionKey fallback matters for MCP-dispatched lanes whose packetId the
    // client projection can't resolve (#1389).
    const query = row.packetId
      ? `packetId=${encodeURIComponent(row.packetId)}`
      : row.sessionKey
        ? `sessionKey=${encodeURIComponent(row.sessionKey)}`
        : null;
    if (!query) {
      setTranscript({ status: 'unavailable', lastMessage: null, lastActivity: null });
      return;
    }
    setTranscript({ status: 'loading', lastMessage: null, lastActivity: null });
    const controller = new AbortController();
    (async () => {
      try {
        const response = await fetch(
          `/api/orchestrator/packet-transcript?${query}&tail=1&limit=30`,
          { signal: controller.signal, cache: 'no-store' },
        );
        const payload = response.ok
          ? await response.json().catch(() => null) as { events?: TranscriptEvent[] } | null
          : null;
        if (controller.signal.aborted) return;
        if (!payload || !Array.isArray(payload.events)) {
          setTranscript({ status: 'unavailable', lastMessage: null, lastActivity: null });
          return;
        }
        setTranscript({ status: 'loaded', ...summarizeTranscriptTail(payload.events) });
      } catch {
        if (!controller.signal.aborted) {
          setTranscript({ status: 'unavailable', lastMessage: null, lastActivity: null });
        }
      }
    })();
    return () => controller.abort();
  }, [row.packetId, row.sessionKey]);

  if (!anchorRect || typeof document === 'undefined') return null;

  const position = resolveHoverPosition(anchorRect);
  const state = deriveSpawnedAgentState(row.laneStatus, row.status, row.lastEventLabel, row.outcome);

  return createPortal(
    <div
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{
        position: 'fixed',
        left: position.left,
        top: position.top,
        zIndex: 10000,
        width: CARD_WIDTH,
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
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 11 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
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
            }}
            title={row.name}
          >
            {row.name}
          </div>
          <div
            style={{
              marginTop: 4,
              fontSize: 9.5,
              fontWeight: 260,
              letterSpacing: '-0.4px',
              lineHeight: 1.25,
              color: 'var(--t-text-faint)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {row.runtime || row.origin}
          </div>
        </div>
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            minHeight: 22,
            paddingTop: 3,
            paddingRight: 8,
            paddingBottom: 3,
            paddingLeft: 8,
            borderRadius: 999,
            border: '1px solid var(--t-panel-border)',
            background: 'var(--t-panel-hover)',
            color: state.color,
            flexShrink: 0,
          }}
        >
          <span
            aria-hidden
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: state.color,
              flexShrink: 0,
            }}
          />
          <span style={{ fontSize: 10.5, fontWeight: 300, letterSpacing: '-0.1px' }}>
            {state.label}
          </span>
        </div>
      </div>

      <div style={{ display: 'grid', gap: 7 }}>
        <MetaRow label="Elapsed" value={formatSpawnedAgentElapsed(row.lastActivityAt, now)} />
        <MetaRow label="Branch" value={row.subtitle || row.repoPath || 'No branch reported'} />
        {row.repoPath ? (
          <MetaRow label="Repo" value={row.repoPath.split('/').filter(Boolean).at(-1) ?? row.repoPath} />
        ) : null}
        {row.prNumber ? <MetaRow label="PR" value={`#${row.prNumber}`} /> : null}
        {transcript.lastActivity ? <MetaRow label="Activity" value={transcript.lastActivity} /> : null}
      </div>

      <div
        style={{
          marginTop: 12,
          paddingTop: 10,
          borderTop: '1px solid var(--t-divider-subtle)',
          fontSize: 11.5,
          fontWeight: 300,
          letterSpacing: '-0.1px',
          lineHeight: 1.45,
          color: transcript.lastMessage ? 'var(--t-text-muted)' : 'var(--t-text-faint)',
          display: '-webkit-box',
          WebkitLineClamp: 4,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}
      >
        {transcript.status === 'loading'
          ? 'Loading transcript…'
          : transcript.lastMessage
            ? transcript.lastMessage
            : transcript.status === 'unavailable'
              ? 'No transcript available for this agent.'
              : 'No messages yet.'}
      </div>
    </div>,
    document.body,
  );
}
