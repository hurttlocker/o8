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
const STORAGE_KEY = 'cortex-ide:agent-tile-widths';
const PRUNE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface StoredWidthEntry {
  widths: number[];
  updatedAt: number;
}
type StoredWidthMap = Record<string, StoredWidthEntry>;

function evenWidths(count: number): number[] {
  if (count <= 0) return [];
  const base = Math.floor((100 / count) * 100) / 100;
  const widths = Array.from({ length: count }, () => base);
  const sum = widths.reduce((total, value) => total + value, 0);
  widths[count - 1] = Number((widths[count - 1] + (100 - sum)).toFixed(2));
  return widths;
}

function hashSessions(sessions: string[]): string {
  return sessions.slice().sort().join('|');
}

function loadStoredWidthMap(): StoredWidthMap {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const result: StoredWidthMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const candidate = value as { widths?: unknown; updatedAt?: unknown };
      if (
        Array.isArray(candidate.widths)
        && candidate.widths.every((n) => typeof n === 'number' && Number.isFinite(n))
        && typeof candidate.updatedAt === 'number'
      ) {
        result[key] = { widths: candidate.widths as number[], updatedAt: candidate.updatedAt };
      }
    }
    return result;
  } catch {
    return {};
  }
}

function saveStoredWidthMap(hash: string, widths: number[]): void {
  if (typeof window === 'undefined') return;
  try {
    const map = loadStoredWidthMap();
    const now = Date.now();
    map[hash] = { widths, updatedAt: now };
    for (const [key, entry] of Object.entries(map)) {
      if (now - entry.updatedAt > PRUNE_AGE_MS) {
        delete map[key];
      }
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // localStorage may be full or disabled; silently ignore.
  }
}

function readWidthsForHash(hash: string, count: number): number[] | null {
  const map = loadStoredWidthMap();
  const entry = map[hash];
  if (entry && entry.widths.length === count) return entry.widths;
  return null;
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
  const sessionsHash = useMemo(() => hashSessions(sessions), [sessions]);
  const [storedWidths, setStoredWidths] = useState<{ hash: string; widths: number[] }>(() => {
    const persisted = readWidthsForHash(sessionsHash, sessions.length);
    return { hash: sessionsHash, widths: persisted ?? evenWidths(sessions.length) };
  });
  const [focusedSession, setFocusedSession] = useState<string | null>(sessions[0] ?? null);
  const [hoveredDivider, setHoveredDivider] = useState<number | null>(null);
  const [draggingDivider, setDraggingDivider] = useState<number | null>(null);

  const widths = useMemo(
    () => {
      if (storedWidths.hash === sessionsHash && storedWidths.widths.length === sessions.length) {
        return storedWidths.widths;
      }
      return readWidthsForHash(sessionsHash, sessions.length) ?? evenWidths(sessions.length);
    },
    [sessions.length, sessionsHash, storedWidths],
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
    let latestWidths = startWidths;

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
      latestWidths = nextWidths;
      setStoredWidths({ hash: sessionsHash, widths: nextWidths });
    };

    const handleUp = () => {
      setDraggingDivider(null);
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
      // Persist final widths once the user releases the divider so layout
      // survives unmount/remount and full app restarts.
      if (latestWidths.length === sessions.length) {
        saveStoredWidthMap(sessionsHash, latestWidths);
      }
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
            // Apple HIG drag handle: visible bar stays at 4px to keep panes
            // tight, but the draggable region is widened via transparent
            // padding so the cursor zone meets the 44pt minimum.
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={`Resize panes ${index + 1} and ${index + 2}`}
              onMouseDown={(event) => startResize(index, event)}
              onMouseEnter={() => setHoveredDivider(index)}
              onMouseLeave={() => setHoveredDivider((current) => current === index ? null : current)}
              style={{
                position: 'relative',
                width: DIVIDER_WIDTH,
                minWidth: DIVIDER_WIDTH,
                cursor: 'col-resize',
                background: 'transparent',
                flexShrink: 0,
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  top: 0,
                  bottom: 0,
                  left: '50%',
                  width: DIVIDER_WIDTH,
                  transform: 'translateX(-50%)',
                  borderRadius: 999,
                  background: hoveredDivider === index || draggingDivider === index
                    ? 'var(--t-border-hover, var(--t-accent-border))'
                    : 'var(--t-border)',
                  pointerEvents: 'none',
                }}
              />
              <span
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  top: 0,
                  bottom: 0,
                  left: '50%',
                  // Hit zone widened to 12px per side (24px total) — full HIG
                  // 44 would overhang the panes and steal pane-internal clicks.
                  // The handle is full-height vertically so the long-axis
                  // dimension already exceeds 44pt for any pane > 44 tall.
                  width: 24,
                  transform: 'translateX(-50%)',
                  background: 'transparent',
                }}
              />
            </div>
          ) : null}
        </Fragment>
      ))}
    </div>
  );
}
