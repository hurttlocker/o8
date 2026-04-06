import type { CSSProperties } from 'react';
import type { BoardColumnId, BoardTaskView } from '@/lib/board/types';
import type { BoardEditorState, StatusTone, TaskAnchor } from './types';
import { COLUMN_ORDER } from './constants';

export function relativeAge(timestamp?: string | null) {
  if (!timestamp) return 'just now';
  const delta = Math.max(0, Date.now() - new Date(timestamp).getTime());
  const minute = 60_000;
  const hour = 60 * minute;
  if (delta < minute) return 'just now';
  if (delta < hour) return `${Math.max(1, Math.round(delta / minute))}m ago`;
  return `${Math.max(1, Math.round(delta / hour))}h ago`;
}

export function compactPath(value?: string | null) {
  if (!value) return null;
  return value.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
}

export function normalizeColumnId(value?: string | null): BoardColumnId | null {
  if (value === 'backlog' || value === 'in_progress' || value === 'review' || value === 'trash') {
    return value;
  }
  return null;
}

export function cubicPoint(
  t: number,
  p0x: number,
  p0y: number,
  p1x: number,
  p1y: number,
  p2x: number,
  p2y: number,
  p3x: number,
  p3y: number,
) {
  const inverse = 1 - t;
  const inverseSquared = inverse * inverse;
  const inverseCubed = inverseSquared * inverse;
  const tSquared = t * t;
  const tCubed = tSquared * t;
  return {
    x: inverseCubed * p0x + 3 * inverseSquared * t * p1x + 3 * inverse * tSquared * p2x + tCubed * p3x,
    y: inverseCubed * p0y + 3 * inverseSquared * t * p1y + 3 * inverse * tSquared * p2y + tCubed * p3y,
  };
}

export function buildDependencyPath(source: TaskAnchor, target: TaskAnchor | { centerX: number; centerY: number }, draft = false) {
  const sourceOrder = source.columnId ? COLUMN_ORDER.indexOf(source.columnId) : -1;
  const targetOrder = 'columnId' in target && target.columnId ? COLUMN_ORDER.indexOf(target.columnId) : -1;
  const startOnLeft = !draft && sourceOrder > -1 && targetOrder > -1 && sourceOrder > targetOrder;
  const endOnLeft = draft
    ? target.centerX >= source.centerX
    : sourceOrder > -1 && targetOrder > -1 && sourceOrder < targetOrder;

  const startX = startOnLeft ? source.left - 6 : source.right + 6;
  const startY = source.centerY;
  const endX = endOnLeft ? target.centerX - 6 : target.centerX + (draft ? 0 : 6);
  const endY = target.centerY;
  const horizontalDistance = Math.abs(endX - startX);
  const controlOffset = Math.max(44, Math.min(160, horizontalDistance * 0.42));
  const control1X = startOnLeft ? startX - controlOffset : startX + controlOffset;
  const control2X = endOnLeft ? endX - controlOffset : endX + controlOffset;
  const midpoint = cubicPoint(0.5, startX, startY, control1X, startY, control2X, endY, endX, endY);

  return {
    path: `M ${startX} ${startY} C ${control1X} ${startY}, ${control2X} ${endY}, ${endX} ${endY}`,
    midpointX: midpoint.x,
    midpointY: midpoint.y,
  };
}

export function statusTone(task: BoardTaskView): StatusTone {
  if (task.reviewReady) {
    return {
      label: 'Review ready',
      color: '#15803d',
      background: 'rgba(34,197,94,0.12)',
      border: 'rgba(34,197,94,0.18)',
    };
  }
  if (task.columnId === 'in_progress') {
    return {
      label: task.runtimeSession?.status === 'reviewing' ? 'Reviewing' : 'Running',
      color: '#1d4ed8',
      background: 'rgba(37,99,235,0.12)',
      border: 'rgba(37,99,235,0.18)',
    };
  }
  if (task.blocked) {
    return {
      label: 'Blocked',
      color: '#b45309',
      background: 'rgba(249,115,22,0.12)',
      border: 'rgba(249,115,22,0.18)',
    };
  }
  if (task.columnId === 'trash') {
    return {
      label: task.archiveReason === 'discarded' ? 'Discarded' : 'Archived',
      color: task.archiveReason === 'discarded' ? '#b91c1c' : '#475569',
      background: task.archiveReason === 'discarded' ? 'rgba(239,68,68,0.1)' : 'rgba(148,163,184,0.14)',
      border: task.archiveReason === 'discarded' ? 'rgba(239,68,68,0.16)' : 'rgba(148,163,184,0.18)',
    };
  }
  return {
    label: task.startable ? 'Ready' : 'Queued',
    color: '#475569',
    background: 'rgba(148,163,184,0.14)',
    border: 'rgba(148,163,184,0.18)',
  };
}

export function taskStatusClass(task: BoardTaskView) {
  if (task.columnId === 'trash') {
    return task.archiveReason === 'discarded' ? 'status-critical' : 'status-stable';
  }
  if (task.reviewReady || task.columnId === 'review') {
    return 'status-reviewing';
  }
  if (task.columnId === 'in_progress') {
    return 'status-running';
  }
  if (task.blocked) {
    return 'status-warning';
  }
  return task.startable ? 'status-healthy' : 'status-stable';
}

export function runtimeStatusClass(status?: string | null) {
  switch (status) {
    case 'running':
      return 'status-running';
    case 'reviewing':
      return 'status-reviewing';
    case 'blocked':
    case 'failed':
      return 'status-critical';
    case 'waiting':
      return 'status-warning';
    case 'idle':
    default:
      return 'status-stable';
  }
}

export function taskReviewLabel(task: BoardTaskView) {
  if (task.columnId === 'trash') {
    return task.archiveReason === 'discarded' ? 'Discarded' : 'Archived';
  }
  if (task.columnId === 'review') return 'Needs operator decision';
  if (task.reviewReady) return 'Ready to review';
  if (task.columnId === 'in_progress') return 'Awaiting review signal';
  return task.blocked ? 'Blocked by dependency' : 'Waiting to start';
}

export function archiveReasonLabel(reason?: 'completed' | 'discarded' | null) {
  if (reason === 'discarded') return 'Discarded';
  if (reason === 'completed') return 'Archived';
  return 'Active';
}

export function taskWorkspaceSummary(task: BoardTaskView) {
  if (task.columnId === 'trash') {
    return task.archiveReason === 'discarded'
      ? 'Removed from the active lane but preserved as board history.'
      : 'Archived from review with a preserved runtime snapshot, not a live binding.';
  }
  if (task.columnId === 'review') {
    return 'Use the review surface to inspect the live worktree and decide whether to archive or continue.';
  }
  if (task.columnId === 'in_progress') {
    return 'This task is tied to a live runtime and worktree. Review can only happen from a real review-ready signal.';
  }
  return 'Backlog stays honest: dependencies gate start, and starting launches a real runtime with a real worktree.';
}

export function normalizeNumeric(value: string) {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function buildEditorState(task: BoardTaskView): BoardEditorState {
  return {
    title: task.title,
    prompt: task.prompt,
    preferredRuntime: task.preferredRuntime,
    baseBranch: task.baseBranch,
    issueId: task.bindings.issueId ? String(task.bindings.issueId) : '',
    prId: task.bindings.prId ? String(task.bindings.prId) : '',
    startInPlanMode: task.automation.startInPlanMode,
  };
}

export function miniActionButtonStyle(kind: 'primary' | 'secondary' | 'danger'): CSSProperties {
  const secondary = kind === 'secondary';
  return {
    width: kind === 'primary' || secondary ? 'auto' : 28,
    height: 28,
    paddingTop: kind === 'primary' || secondary ? 0 : 0,
    paddingRight: kind === 'primary' || secondary ? 10 : 0,
    paddingBottom: kind === 'primary' || secondary ? 0 : 0,
    paddingLeft: kind === 'primary' || secondary ? 10 : 0,
    borderRadius: 999,
    border:
      kind === 'primary'
        ? 'none'
        : secondary
          ? '1px solid var(--border)'
          : '1px solid rgba(248,113,113,0.22)',
    background:
      kind === 'primary'
        ? 'var(--blue)'
        : secondary
          ? 'var(--panel-strong)'
          : 'rgba(255,255,255,0.08)',
    color:
      kind === 'primary'
        ? '#ffffff'
        : secondary
          ? 'var(--text)'
          : '#b91c1c',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    fontSize: 11,
    fontWeight: 700,
  };
}

export function toolbarButtonStyle(spinning: boolean): CSSProperties {
  return {
    height: 36,
    borderRadius: 14,
    border: '1px solid var(--border)',
    background: 'var(--panel-strong)',
    backdropFilter: 'blur(16px)',
    WebkitBackdropFilter: 'blur(16px)',
    color: 'var(--text)',
    paddingTop: 0,
    paddingRight: 12,
    paddingBottom: 0,
    paddingLeft: 12,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 12,
    fontWeight: 700,
    opacity: spinning ? 0.84 : 1,
  };
}
