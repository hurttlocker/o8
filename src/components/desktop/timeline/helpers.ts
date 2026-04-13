import type { AgentSummary } from '@/lib/fleet/types';
import type { SegmentKind } from './types';
import {
  TIMELINE_ACTIVE_SEGMENT_MIN_PX,
  TIMELINE_BAR_HEIGHT,
  TIMELINE_TESTING_MIN_PX,
  TIMELINE_THINKING_MIN_PX,
} from './constants';

export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export function formatTime(minutesSinceAnchor: number): string {
  // Anchor is 6 AM (matches API route rolling window)
  const h = 6 + Math.floor(minutesSinceAnchor / 60);
  const m = minutesSinceAnchor % 60;
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h > 12 ? h - 12 : h === 0 ? 12 : h;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

export function timelineSegmentLayer(kind: SegmentKind) {
  switch (kind) {
    case 'coding': return 1;
    case 'thinking': return 2;
    case 'testing': return 3;
    case 'error': return 4;
    default: return 0;
  }
}

export function timelineSegmentMinWidth(kind: SegmentKind) {
  if (kind === 'error') return 7;
  if (kind === 'thinking') return TIMELINE_THINKING_MIN_PX;
  if (kind === 'testing') return TIMELINE_TESTING_MIN_PX;
  return TIMELINE_ACTIVE_SEGMENT_MIN_PX;
}

export function timelineSegmentDisplayWidth(kind: SegmentKind, actualWidthPx: number) {
  const minWidthPx = timelineSegmentMinWidth(kind);
  if (actualWidthPx <= minWidthPx) return minWidthPx;
  if (kind === 'coding' && actualWidthPx < 9) return 9;
  if (kind === 'thinking' && actualWidthPx < 12) return 12;
  if (kind === 'testing' && actualWidthPx < 10) return 10;
  if (kind === 'error' && actualWidthPx < 8) return 8;
  return actualWidthPx;
}

export function timelineSegmentChrome(_kind: SegmentKind, color: string, hovered: boolean) {
  // Watercolor: uniform height, wide feathered edges, no hard boundaries
  return {
    top: 2,
    height: TIMELINE_BAR_HEIGHT - 4,
    borderRadius: 999,
    opacity: hovered ? 0.95 : 0.7,
    background: `linear-gradient(90deg, ${color}00 0%, ${color}90 20%, ${color} 40%, ${color} 60%, ${color}90 80%, ${color}00 100%)`,
    boxShadow: 'none',
    transform: 'none',
  };
}

export function runtimeLabel(runtime: string | null | undefined): string {
  if (runtime === 'claude-code') return 'Claude Code';
  if (runtime === 'codex') return 'Codex';
  return runtime || 'Runtime';
}

export function compactWorkspacePath(path: string | null | undefined): string | null {
  if (!path || path === 'unknown') return null;
  const normalized = path.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length <= 4) return normalized;
  return `~/${parts.slice(-4).join('/')}`;
}

export function cleanTaskLabel(task: string | null | undefined): string | null {
  if (!task) return null;
  return task
    .replace(/^IDE-owned Codex session ready for the next input via resume\.?\s*/i, '')
    .replace(/^Live Codex terminal verified via pid\/log mapping on s\d+\.\s*/i, '')
    .replace(/^Live Codex terminal detected on s\d+\.\s*/i, '')
    .replace(/^Recent automation surface; useful for visibility, not the primary operator lane\.?\s*/i, '')
    .replace(/^Mirroring the live Q ↔ Mister conversation, not spawning a fresh session\.?\s*/i, '')
    .trim();
}

export function humanizeStatus(status: string | null | undefined): string {
  if (!status) return 'Idle';
  if (status === 'reviewing') return 'Reviewing';
  if (status === 'running') return 'Running';
  if (status === 'waiting') return 'Waiting';
  if (status === 'blocked') return 'Blocked';
  if (status === 'failed') return 'Failed';
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export function timelineMatchesAgent(agentName: string, session: AgentSummary): boolean {
  const key = session.sessionKey.toLowerCase();
  const name = (session.name || '').toLowerCase();
  if (agentName === 'codex') return session.runtime === 'codex';
  const loweredAgent = agentName.toLowerCase();
  return name.includes(loweredAgent) || key.includes(loweredAgent);
}

export function timelinePrimarySession(sessions: AgentSummary[]): AgentSummary | null {
  if (sessions.length === 0) return null;
  const statusWeight = (status: string) => {
    switch (status) {
      case 'running': return 4;
      case 'reviewing': return 3;
      case 'waiting': return 2;
      case 'idle': return 1;
      default: return 0;
    }
  };
  return [...sessions].sort((a, b) => {
    if (Boolean(a.isCurrentSession) !== Boolean(b.isCurrentSession)) return a.isCurrentSession ? -1 : 1;
    const delta = statusWeight(b.status) - statusWeight(a.status);
    if (delta !== 0) return delta;
    return new Date(b.lastEventAt || 0).getTime() - new Date(a.lastEventAt || 0).getTime();
  })[0] ?? null;
}
