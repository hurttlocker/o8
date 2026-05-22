'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { ChevronDown } from '../../../lucide-shims';
import { REPO_FOCUS_FONT } from '../../utils';
import type { TaskAction, TaskActionMenuState, TaskPoolTask } from './types';
import { FIELD_SURFACE, FLOATING_GLASS_SURFACE, GROUP_LABELS } from './constants';
import { baseName, runtimeLabel } from './helpers';
import { ActionButton, MenuActionRow, SectionLabel } from './shared';
import { TaskRow } from './TaskRow';

export function TaskSection({
  label,
  tasks,
  activeSessionKey,
  onSelectSession,
  onOpenMenu,
  limit,
  emptyLabel,
  compactActions = false,
}: {
  label: string;
  tasks: TaskPoolTask[];
  activeSessionKey?: string | null;
  onSelectSession?: (sessionKey: string) => void;
  onOpenMenu?: (task: TaskPoolTask, x: number, y: number) => void;
  limit?: number;
  emptyLabel?: string;
  compactActions?: boolean;
}) {
  if (tasks.length === 0) {
    if (!emptyLabel) return null;
    return (
      <div>
        <SectionLabel label={label} count={0} />
        <div style={{ paddingTop: 7, paddingBottom: 7, color: 'var(--t-text-faint)', fontSize: 11.5, lineHeight: '15px' }}>
          {emptyLabel}
        </div>
      </div>
    );
  }

  const visibleTasks = typeof limit === 'number' ? tasks.slice(0, limit) : tasks;
  const overflow = tasks.length - visibleTasks.length;

  return (
    <div>
      <SectionLabel label={label} count={tasks.length} />
      {visibleTasks.map((task) => (
        <TaskRow
          key={task.id}
          task={task}
          active={Boolean(task.lane?.sessionKey && task.lane.sessionKey === activeSessionKey)}
          onSelectSession={onSelectSession}
          onOpenMenu={onOpenMenu}
          compactActions={compactActions}
        />
      ))}
      {overflow > 0 ? (
        <div style={{ paddingTop: 6, paddingBottom: 2, color: 'var(--t-text-faint)', fontSize: 10.5, lineHeight: '14px' }}>
          + {overflow} more ready task{overflow === 1 ? '' : 's'}
        </div>
      ) : null}
    </div>
  );
}

export function CollapsedTaskSection({
  label,
  tasks,
  open,
  onToggle,
  activeSessionKey,
  onSelectSession,
  onOpenMenu,
  limit,
  compactActions = false,
  overflowLabel = 'archived task',
  actionLabel,
  actionDisabled = false,
  actionIcon,
  onAction,
}: {
  label: string;
  tasks: TaskPoolTask[];
  open: boolean;
  onToggle: () => void;
  activeSessionKey?: string | null;
  onSelectSession?: (sessionKey: string) => void;
  onOpenMenu?: (task: TaskPoolTask, x: number, y: number) => void;
  limit?: number;
  compactActions?: boolean;
  overflowLabel?: string;
  actionLabel?: string;
  actionDisabled?: boolean;
  actionIcon?: ReactNode;
  onAction?: () => void;
}) {
  const visibleTasks = typeof limit === 'number' ? tasks.slice(0, limit) : tasks;
  const overflow = tasks.length - visibleTasks.length;

  return (
    <div>
      <div
        style={{
          width: '100%',
          minHeight: 32,
          marginTop: 12,
          borderWidth: 0,
          borderTopWidth: 1,
          borderTopStyle: 'solid',
          borderTopColor: 'var(--t-divider-subtle)',
          background: 'transparent',
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          paddingTop: 6,
          paddingBottom: 2,
        }}
      >
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 24,
            border: 0,
            background: 'transparent',
            color: 'var(--t-text-faint)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            padding: 0,
            textAlign: 'left',
            fontFamily: REPO_FOCUS_FONT,
            fontSize: 10,
            lineHeight: '13px',
            fontWeight: 600,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            transition: 'color 140ms ease',
          }}
          onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--t-text-muted)'; }}
          onMouseLeave={(event) => { event.currentTarget.style.color = 'var(--t-text-faint)'; }}
        >
          <ChevronDown
            size={11}
            strokeWidth={2}
            style={{
              flexShrink: 0,
              transform: open ? 'rotate(0deg)' : 'rotate(-90deg)',
              transition: 'transform 140ms ease',
            }}
          />
          <span style={{ flex: 1, minWidth: 0 }}>{label}</span>
          <span style={{ fontSize: 9.5, lineHeight: '12px', letterSpacing: 0, fontWeight: 500 }}>
            {tasks.length}
          </span>
        </button>
        {onAction ? (
          <button
            type="button"
            aria-label={actionLabel}
            title={actionLabel}
            disabled={actionDisabled}
            onClick={(event) => {
              event.stopPropagation();
              if (!actionDisabled) onAction();
            }}
            style={{
              width: 22,
              height: 22,
              border: 0,
              borderRadius: 7,
              background: 'transparent',
              color: actionDisabled ? 'var(--t-text-faint)' : 'var(--t-text-muted)',
              cursor: actionDisabled ? 'default' : 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 0,
            }}
          >
            {actionIcon}
          </button>
        ) : null}
      </div>
      {open ? (
        <>
          {visibleTasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              active={Boolean(task.lane?.sessionKey && task.lane.sessionKey === activeSessionKey)}
              onSelectSession={onSelectSession}
              onOpenMenu={onOpenMenu}
              compactActions={compactActions}
            />
          ))}
          {overflow > 0 ? (
            <div style={{ paddingTop: 6, paddingBottom: 2, color: 'var(--t-text-faint)', fontSize: 10.5, lineHeight: '14px' }}>
              + {overflow} more {overflowLabel}{overflow === 1 ? '' : 's'}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

export function TaskActionMenu({
  state,
  busyKey,
  onClose,
  onSelectSession,
  onAction,
}: {
  state: TaskActionMenuState;
  busyKey: string | null;
  onClose: () => void;
  onSelectSession?: (sessionKey: string) => void;
  onAction: (task: TaskPoolTask, action: TaskAction, body?: Record<string, unknown>) => void;
}) {
  const [mode, setMode] = useState<'menu' | 'block' | 'report'>('menu');
  const [detail, setDetail] = useState('');

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const task = state.task;
  const busy = busyKey?.endsWith(`:${task.id}`) ?? false;
  const viewportWidth = typeof window === 'undefined' ? 1200 : window.innerWidth;
  const viewportHeight = typeof window === 'undefined' ? 800 : window.innerHeight;
  const menuWidth = 248;
  const menuHeight = mode === 'menu' ? 266 : 214;
  const panelRect = typeof document === 'undefined'
    ? null
    : document.querySelector('[data-o8-agent-panel="true"]')?.getBoundingClientRect() ?? null;
  const boundaryLeft = panelRect?.left ?? 0;
  const boundaryRight = panelRect?.right ?? viewportWidth;
  const boundaryTop = panelRect?.top ?? 0;
  const boundaryBottom = panelRect?.bottom ?? viewportHeight;
  const minLeft = boundaryLeft + 8;
  const maxLeft = Math.max(minLeft, boundaryRight - menuWidth - 8);
  const desiredLeft = state.x + menuWidth > boundaryRight - 8 ? state.x - menuWidth + 18 : state.x;
  const left = Math.min(Math.max(desiredLeft, minLeft), maxLeft);
  const minTop = boundaryTop + 8;
  const maxTop = Math.max(minTop, boundaryBottom - menuHeight - 8);
  const top = Math.min(Math.max(state.y, minTop), maxTop);
  const sessionKey = task.lane?.sessionKey ?? null;
  const taskIsDone = task.group === 'done';

  return (
    <>
      <button
        type="button"
        aria-label="Close task action menu"
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 48,
          border: 0,
          background: 'transparent',
          cursor: 'default',
        }}
      />
      <div
        data-o8-task-action-menu="true"
        style={{
          position: 'fixed',
          left,
          top,
          zIndex: 49,
          width: 248,
          borderRadius: 16,
          border: '1px solid var(--t-divider-subtle)',
          background: FLOATING_GLASS_SURFACE,
          boxShadow: '0 22px 64px rgba(15, 23, 42, 0.14)',
          backdropFilter: 'blur(20px) saturate(145%)',
          WebkitBackdropFilter: 'blur(20px) saturate(145%)',
          padding: 8,
          color: 'var(--t-text)',
          fontFamily: REPO_FOCUS_FONT,
        }}
      >
        <div style={{ padding: '5px 6px 8px' }}>
          <div style={{ fontSize: 11.5, lineHeight: '15px', fontWeight: 650, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {task.title}
          </div>
          <div style={{ marginTop: 1, color: 'var(--t-text-faint)', fontSize: 10.25, lineHeight: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {task.repoName ?? baseName(task.repoPath)} - {GROUP_LABELS[task.group]} - {runtimeLabel(task.workerRouting?.selectedRuntime ?? task.runtime)}
          </div>
        </div>

        {mode === 'menu' ? (
          <div style={{ display: 'grid', gap: 3 }}>
            <MenuActionRow
              label="Open session"
              disabled={!sessionKey}
              onClick={() => {
                if (sessionKey) onSelectSession?.(sessionKey);
                onClose();
              }}
            />
            <MenuActionRow
              label="Claim"
              disabled={busy}
              onClick={() => onAction(task, 'claim', { note: 'Claimed from Control Room.' })}
            />
            <MenuActionRow
              label="Dispatch"
              disabled={busy}
              primary
              onClick={() => onAction(task, 'dispatch', { message: 'Dispatched from Control Room.' })}
            />
            <MenuActionRow
              label="Report progress..."
              disabled={busy}
              onClick={() => setMode('report')}
            />
            <MenuActionRow
              label="Block..."
              disabled={busy}
              danger
              onClick={() => setMode('block')}
            />
            <MenuActionRow
              label={taskIsDone ? 'Prune permanently' : 'Prune / archive'}
              disabled={busy}
              danger={taskIsDone}
              onClick={() => onAction(
                task,
                taskIsDone ? 'prune' : 'archive',
                { reason: taskIsDone ? 'Pruned from Control Room.' : 'Archived from Control Room.' },
              )}
            />
          </div>
        ) : (
          <div style={{ padding: '2px 4px 4px' }}>
            <textarea
              value={detail}
              onChange={(event) => setDetail(event.currentTarget.value)}
              rows={3}
              placeholder={mode === 'block' ? 'Why is it blocked?' : 'What changed?'}
              style={{
                width: '100%',
                minHeight: 62,
                resize: 'vertical',
                border: '1px solid var(--t-divider-subtle)',
                borderRadius: 11,
                background: FIELD_SURFACE,
                color: 'var(--t-text)',
                outline: 'none',
                padding: 8,
                fontFamily: REPO_FOCUS_FONT,
                fontSize: 11.25,
                lineHeight: '15px',
              }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 7 }}>
              <ActionButton label="Back" disabled={busy} onClick={() => setMode('menu')} />
              <ActionButton
                label={mode === 'block' ? 'Block' : 'Report'}
                primary={mode === 'report'}
                disabled={busy || !detail.trim()}
                onClick={() => {
                  const message = detail.trim();
                  if (!message) return;
                  if (mode === 'block') {
                    onAction(task, 'block', { reason: message, code: 'needs_clarification' });
                  } else {
                    onAction(task, 'report', { event: 'progress', message });
                  }
                }}
              />
            </div>
          </div>
        )}
      </div>
    </>
  );
}
