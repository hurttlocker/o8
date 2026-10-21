'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { ChevronDown } from '../../../lucide-shims';
import { REPO_FOCUS_FONT } from '../../utils';
import type { TaskAction, TaskActionMenuState, TaskPoolTask } from './types';
import { FIELD_SURFACE, FLOATING_GLASS_SURFACE, GROUP_LABELS } from './constants';
import { baseName, runtimeLabel, taskSessionKey } from './helpers';
import { ActionButton, MenuActionRow, SectionLabel } from './shared';
import { TaskRow } from './TaskRow';
import { RemoteTaskPreview } from './RemoteTaskPreview';

interface RemoteEvidencePayload {
  packetId: string;
  jobId: string;
  attempt: number;
  status: string;
  leaseState: string;
  logs: { id: number; text: string; createdAt: string }[];
  files: { path: string; status: string; additions: number; deletions: number }[];
  logsTruncated: boolean;
  filesTruncated: boolean;
}

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
          active={Boolean(taskSessionKey(task) && taskSessionKey(task) === activeSessionKey)}
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
              active={Boolean(taskSessionKey(task) && taskSessionKey(task) === activeSessionKey)}
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
  boundaryElement,
  busyKey,
  onClose,
  onRefreshTask,
  onSelectSession,
  onAction,
}: {
  state: TaskActionMenuState;
  boundaryElement?: HTMLElement | null;
  busyKey: string | null;
  onClose: () => void;
  onRefreshTask: () => Promise<void>;
  onSelectSession?: (sessionKey: string) => void;
  onAction: (task: TaskPoolTask, action: TaskAction, body?: Record<string, unknown>) => void;
}) {
  const [mode, setMode] = useState<'menu' | 'block' | 'report' | 'evidence' | 'preview'>('menu');
  const [detail, setDetail] = useState('');
  const [evidence, setEvidence] = useState<RemoteEvidencePayload | null>(null);
  const [evidenceError, setEvidenceError] = useState<{ key: string; message: string } | null>(null);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [evidenceReload, setEvidenceReload] = useState(0);
  const task = state.task;
  const evidenceJobId = task.execution?.jobId;
  const evidenceAttempt = task.execution?.attempt;
  const evidenceKey = `${task.id}:${evidenceJobId}:${evidenceAttempt}`;
  const currentEvidence = evidence && evidence.packetId === task.packetId && evidence.jobId === evidenceJobId && evidence.attempt === evidenceAttempt ? evidence : null;
  const currentError = evidenceError?.key === evidenceKey ? evidenceError.message : null;

  useEffect(() => {
    if (mode !== 'evidence' || !evidenceJobId || evidenceAttempt === undefined) return;
    let active = true;
    const requestKey = `${task.id}:${evidenceJobId}:${evidenceAttempt}`;
    const controller = new AbortController();
    const params = new URLSearchParams({ jobId: evidenceJobId, attempt: String(evidenceAttempt) });
    void fetch(`/api/tasks/${encodeURIComponent(task.id)}/evidence?${params}`, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const body = await response.json().catch(() => ({})) as RemoteEvidencePayload & { error?: string };
        if (!response.ok) throw new Error(body.error || 'Remote evidence is unavailable.');
        if (active) { setEvidence(body); setEvidenceError(null); }
      })
      .catch((error: unknown) => { if (active) setEvidenceError({ key: requestKey, message: error instanceof Error ? error.message : 'Remote evidence is unavailable.' }); })
      .finally(() => { if (active) setEvidenceLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [mode, task.id, evidenceJobId, evidenceAttempt, evidenceReload]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const busy = busyKey?.endsWith(`:${task.id}`) ?? false;
  const viewportWidth = typeof window === 'undefined' ? 1200 : window.innerWidth;
  const viewportHeight = typeof window === 'undefined' ? 800 : window.innerHeight;
  const canUnqueue = state.task.group === 'ready' || state.task.group === 'blocked';
  const menuHeight = mode === 'preview' ? 540 : mode === 'evidence' ? 480 : mode === 'menu' ? (canUnqueue ? 331 : 298) : 214;
  const panelRect = boundaryElement?.getBoundingClientRect();
  let boundaryLeft = Math.max(0, panelRect?.left ?? 0);
  let boundaryRight = Math.min(viewportWidth, panelRect?.right ?? viewportWidth);
  let boundaryTop = Math.max(0, panelRect?.top ?? 0);
  let boundaryBottom = Math.min(viewportHeight, panelRect?.bottom ?? viewportHeight);
  // The board can extend beyond a scroll container or clipped project sheet.
  // Keep the entire popup, including its actions, inside the visible portion.
  for (let parent = boundaryElement?.parentElement; parent; parent = parent.parentElement) {
    const style = window.getComputedStyle(parent);
    const rect = parent.getBoundingClientRect();
    const clipsBoth = Boolean(style.clipPath && style.clipPath !== 'none') || /paint|strict|content/.test(style.contain);
    if (clipsBoth || /auto|scroll|hidden|clip/.test(style.overflowX || style.overflow)) {
      boundaryLeft = Math.max(boundaryLeft, rect.left);
      boundaryRight = Math.min(boundaryRight, rect.right);
    }
    if (clipsBoth || /auto|scroll|hidden|clip/.test(style.overflowY || style.overflow)) {
      boundaryTop = Math.max(boundaryTop, rect.top);
      boundaryBottom = Math.min(boundaryBottom, rect.bottom);
    }
  }
  const menuWidth = Math.min(mode === 'preview' ? 780 : mode === 'evidence' ? 480 : 248, Math.max(180, boundaryRight - boundaryLeft - 16));
  const minLeft = boundaryLeft + 8;
  const maxLeft = Math.max(minLeft, boundaryRight - menuWidth - 8);
  const desiredLeft = state.x + menuWidth > boundaryRight - 8 ? state.x - menuWidth + 18 : state.x;
  const left = Math.min(Math.max(desiredLeft, minLeft), maxLeft);
  const minTop = boundaryTop + 8;
  const maxTop = Math.max(minTop, boundaryBottom - menuHeight - 8);
  const top = Math.min(Math.max(state.y, minTop), maxTop);
  const sessionKey = taskSessionKey(task);
  const taskIsDone = task.group === 'done';
  const taskCanUnqueue = task.group === 'ready' || task.group === 'blocked';

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
          width: menuWidth,
          maxHeight: Math.max(180, boundaryBottom - boundaryTop - 16),
          overflowY: mode === 'evidence' ? 'auto' : 'visible',
          scrollbarWidth: 'none',
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
          <div style={{ fontSize: 11.5, lineHeight: '15px', fontWeight: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
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
            {task.execution ? (
              <MenuActionRow label="Remote logs & files" onClick={() => {
                setEvidenceLoading(true);
                setEvidence(null);
                setEvidenceError(null);
                setMode('evidence');
              }} />
            ) : null}
            {task.execution ? <MenuActionRow label="Remote preview" disabled={task.execution.previewAccess !== 'requestable'} onClick={() => setMode('preview')} /> : null}
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
            {taskCanUnqueue ? (
              <MenuActionRow
                label="Un-queue / remove"
                disabled={busy}
                danger
                onClick={() => onAction(task, 'remove', { reason: 'Un-queued from Control Room.' })}
              />
            ) : null}
          </div>
        ) : mode === 'evidence' ? (
          <div style={{ paddingTop: 2, paddingRight: 6, paddingBottom: 6, paddingLeft: 6, fontSize: 11, lineHeight: '16px', color: 'var(--t-text-muted)' }}>
            <div style={{ fontWeight: 300, color: 'var(--t-text)', marginBottom: 6 }}>Remote evidence · attempt {task.execution?.attempt}</div>
            {!currentEvidence && !currentError ? <div>Loading current attempt…</div> : null}
            {currentError ? <div role="alert" style={{ color: 'var(--t-danger, #dc2626)', overflowWrap: 'anywhere' }}>{currentError}</div> : null}
            {currentEvidence ? (
              <>
                <div style={{ marginBottom: 10 }}>{currentEvidence.status} · lease {currentEvidence.leaseState}</div>
                <div style={{ fontWeight: 300, color: 'var(--t-text)', marginBottom: 4 }}>Changed files · {currentEvidence.files.length}{currentEvidence.filesTruncated ? '+' : ''}</div>
                {currentEvidence.files.length ? currentEvidence.files.map((file) => (
                  <div key={`${file.path}:${file.status}`} style={{ display: 'flex', gap: 8, justifyContent: 'space-between', overflowWrap: 'anywhere', marginBottom: 3 }}>
                    <span>{file.status} · {file.path}</span><span style={{ flexShrink: 0 }}>+{file.additions} −{file.deletions}</span>
                  </div>
                )) : <div style={{ marginBottom: 8 }}>No changed-file receipt for this attempt yet.</div>}
                <div style={{ fontWeight: 300, color: 'var(--t-text)', marginTop: 12, marginBottom: 4 }}>Worker log{currentEvidence.logsTruncated ? ' · recent excerpt' : ''}</div>
                {currentEvidence.logs.length ? currentEvidence.logs.map((entry) => (
                  <div key={entry.id} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: 'monospace', fontSize: 10.5, lineHeight: '15px', marginBottom: 5 }}>{entry.text}</div>
                )) : <div>No log receipt for this attempt yet.</div>}
                <div style={{ borderTop: '1px solid var(--t-divider-subtle)', marginTop: 10, paddingTop: 8 }}>Remote editor is unavailable. {task.execution?.previewAccess === 'requestable' ? 'Open Remote preview from the task menu.' : 'Preview is unavailable for this attempt.'}</div>
              </>
            ) : null}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 10 }}>
              <ActionButton label="Back" onClick={() => setMode('menu')} />
              <ActionButton label="Refresh" disabled={evidenceLoading} onClick={() => {
                setEvidenceLoading(true);
                setEvidence(null);
                setEvidenceError(null);
                void onRefreshTask().catch(() => {}).finally(() => setEvidenceReload((value) => value + 1));
              }} />
            </div>
          </div>
        ) : mode === 'preview' && evidenceJobId && evidenceAttempt !== undefined ? (
          <RemoteTaskPreview key={evidenceKey} taskId={task.id} jobId={evidenceJobId} attempt={evidenceAttempt} onBack={() => setMode('menu')} />
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
