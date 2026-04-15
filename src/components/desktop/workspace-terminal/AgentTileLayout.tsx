'use client';

import { Fragment, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import type { FleetAgent } from '@/components/desktop/thoughts/types';
import { AgentTilePane } from './AgentTilePane';

interface AgentTileLayoutProps {
  sessions: string[];
  agents: FleetAgent[];
  onCloseSession: (sessionKey: string) => void;
}

const DIVIDER_WIDTH = 4;
const MIN_PANE_WIDTH = 280;

function evenWidths(count: number): number[] {
  if (count <= 0) return [];
  const base = Math.floor((100 / count) * 100) / 100;
  const widths = Array.from({ length: count }, () => base);
  const sum = widths.reduce((total, value) => total + value, 0);
  widths[count - 1] = Number((widths[count - 1] + (100 - sum)).toFixed(2));
  return widths;
}

function cycleSession(sessions: string[], current: string | null, direction: 1 | -1): string | null {
  if (sessions.length === 0) return null;
  const currentIndex = current ? sessions.indexOf(current) : -1;
  const safeIndex = currentIndex >= 0 ? currentIndex : 0;
  const nextIndex = (safeIndex + direction + sessions.length) % sessions.length;
  return sessions[nextIndex] ?? sessions[0] ?? null;
}

export function AgentTileLayout({
  sessions,
  agents,
  onCloseSession,
}: AgentTileLayoutProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [storedWidths, setStoredWidths] = useState<number[]>(() => evenWidths(sessions.length));
  const [focusedSession, setFocusedSession] = useState<string | null>(sessions[0] ?? null);
  const [hoveredDivider, setHoveredDivider] = useState<number | null>(null);
  const [draggingDivider, setDraggingDivider] = useState<number | null>(null);
  const widths = useMemo(
    () => storedWidths.length === sessions.length ? storedWidths : evenWidths(sessions.length),
    [sessions.length, storedWidths],
  );
  const activeFocusedSession = useMemo(
    () => focusedSession && sessions.includes(focusedSession) ? focusedSession : (sessions[0] ?? null),
    [focusedSession, sessions],
  );
  const agentsBySession = useMemo(
    () => new Map(agents.filter((agent) => agent.sessionKey).map((agent) => [agent.sessionKey!, agent])),
    [agents],
  );

  useEffect(() => {
    if (draggingDivider === null) return undefined;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
  }, [draggingDivider]);

  useEffect(() => {
    if (sessions.length < 2) return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.metaKey || event.altKey || event.ctrlKey) return;
      if (event.code !== 'BracketLeft' && event.code !== 'BracketRight') return;
      event.preventDefault();
      setFocusedSession((current) => cycleSession(
        sessions,
        current && sessions.includes(current) ? current : (sessions[0] ?? null),
        event.code === 'BracketRight' ? 1 : -1,
      ));
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [sessions]);

  const startResize = (dividerIndex: number, event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const availableWidth = rect.width - ((sessions.length - 1) * DIVIDER_WIDTH);
    if (availableWidth <= 0) return;

    const startX = event.clientX;
    const startWidths = [...widths];
    const startLeft = startWidths[dividerIndex] ?? 0;
    const startRight = startWidths[dividerIndex + 1] ?? 0;
    const pairTotal = startLeft + startRight;
    const minPercent = Math.min((MIN_PANE_WIDTH / availableWidth) * 100, pairTotal / 2);

    setDraggingDivider(dividerIndex);

    const handleMove = (moveEvent: MouseEvent) => {
      const deltaPercent = ((moveEvent.clientX - startX) / availableWidth) * 100;
      const nextLeft = Math.min(
        pairTotal - minPercent,
        Math.max(minPercent, startLeft + deltaPercent),
      );
      const nextRight = pairTotal - nextLeft;
      const nextWidths = [...startWidths];
      nextWidths[dividerIndex] = Number(nextLeft.toFixed(2));
      nextWidths[dividerIndex + 1] = Number(nextRight.toFixed(2));
      setStoredWidths(nextWidths);
    };

    const handleUp = () => {
      setDraggingDivider(null);
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
    };

    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
  };

  return (
    <div
      ref={containerRef}
      style={{
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        display: 'flex',
        alignItems: 'stretch',
        gap: 0,
        paddingTop: 12,
        paddingRight: 12,
        paddingBottom: 12,
        paddingLeft: 12,
        background: 'var(--t-chat-surface-bg, #ffffff)',
      }}
    >
      {sessions.map((sessionKey, index) => (
        <Fragment key={sessionKey}>
          <div
            style={{
              width: `${widths[index] ?? (100 / Math.max(1, sessions.length))}%`,
              minWidth: 0,
              minHeight: 0,
              display: 'flex',
            }}
          >
            <AgentTilePane
              sessionKey={sessionKey}
              agent={agentsBySession.get(sessionKey) ?? null}
              focused={activeFocusedSession === sessionKey}
              onClose={onCloseSession}
              onFocus={setFocusedSession}
            />
          </div>
          {index < sessions.length - 1 ? (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={`Resize panes ${index + 1} and ${index + 2}`}
              onMouseDown={(event) => startResize(index, event)}
              onMouseEnter={() => setHoveredDivider(index)}
              onMouseLeave={() => setHoveredDivider((current) => current === index ? null : current)}
              style={{
                width: DIVIDER_WIDTH,
                minWidth: DIVIDER_WIDTH,
                cursor: 'col-resize',
                borderRadius: 999,
                background: hoveredDivider === index || draggingDivider === index
                  ? 'var(--t-border-hover, var(--t-accent-border))'
                  : 'var(--t-border)',
                flexShrink: 0,
              }}
            />
          ) : null}
        </Fragment>
      ))}
    </div>
  );
}
