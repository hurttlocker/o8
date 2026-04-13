'use client';

import type { KeyboardEvent } from 'react';
import { memo } from 'react';
import {
  ChevronRight,
  Play,
  RefreshCw,
  RotateCcw,
  Trash2,
} from '../lucide-shims';
import type { TaskCardProps } from './types';
import { taskCardStyle, dependencyHandleStyle, dependencyHandleDotsStyle } from './constants';
import { miniActionButtonStyle, relativeAge, statusTone } from './utils';
import { BoardPill } from './shared';

function TaskCardBase({
  task,
  columnId,
  taskIndex,
  selectedTaskId,
  dragTaskId,
  dropTarget,
  dependencyDraft,
  startBusyTaskId,
  onSelect,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  onDependencyDraftStart,
  onStartTask,
  onMarkReviewReady,
  onArchiveTask,
  onRestoreTask,
}: TaskCardProps) {
  const status = statusTone(task);
  const isDropTarget = dropTarget?.columnId === columnId && dropTarget.index === taskIndex;

  return (
    <div
      draggable
      data-task-id={task.id}
      data-column-id={columnId}
      role="button"
      tabIndex={0}
      onDragStart={(event) => {
        event.dataTransfer.setData('text/plain', task.id);
        event.dataTransfer.effectAllowed = 'move';
        onDragStart(task.id);
      }}
      onDragEnd={() => {
        onDragEnd();
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (dragTaskId) {
          onDragOver(columnId, taskIndex);
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        const taskId = event.dataTransfer.getData('text/plain') || dragTaskId;
        if (taskId) {
          onDrop(taskId, columnId, taskIndex);
        }
      }}
      onClick={() => onSelect(task.id)}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(task.id);
        }
      }}
      style={{
        ...taskCardStyle,
        borderColor: dependencyDraft?.sourceTaskId === task.id
          ? 'rgba(59,130,246,0.5)'
          : dependencyDraft?.targetTaskId === task.id
            ? 'rgba(34,197,94,0.4)'
            : selectedTaskId === task.id
              ? 'rgba(59,130,246,0.34)'
              : 'var(--border)',
        boxShadow: dependencyDraft?.sourceTaskId === task.id
          ? '0 16px 38px rgba(59,130,246,0.18)'
          : dependencyDraft?.targetTaskId === task.id
            ? '0 16px 38px rgba(34,197,94,0.14)'
            : isDropTarget
              ? '0 0 0 1px rgba(59,130,246,0.22), 0 16px 38px rgba(59,130,246,0.12)'
            : selectedTaskId === task.id
              ? '0 14px 36px rgba(59,130,246,0.14)'
              : '0 10px 28px rgba(15,23,42,0.08)',
        transform: dragTaskId === task.id ? 'scale(0.985)' : 'translateY(0)',
      }}
    >
      {task.columnId !== 'trash' ? (
        <button
          type="button"
          aria-label="Pull dependency link"
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onDependencyDraftStart(task.id, event.clientX, event.clientY);
          }}
          style={{
            ...dependencyHandleStyle,
            background: dependencyDraft?.sourceTaskId === task.id
              ? 'rgba(59,130,246,0.92)'
              : dependencyDraft?.targetTaskId === task.id
                ? 'rgba(22,163,74,0.92)'
                : 'var(--panel-strong)',
            borderColor: dependencyDraft?.sourceTaskId === task.id
              ? 'rgba(29,78,216,0.94)'
              : dependencyDraft?.targetTaskId === task.id
                ? 'rgba(22,163,74,0.88)'
                : 'var(--border)',
            color: dependencyDraft?.sourceTaskId === task.id || dependencyDraft?.targetTaskId === task.id
              ? '#ffffff'
              : 'var(--blue)',
          }}
        >
          <span style={dependencyHandleDotsStyle} />
        </button>
      ) : null}

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ minWidth: 0, textAlign: 'left' }}>
          <div style={{ fontSize: 13, fontWeight: 800, lineHeight: 1.35, color: 'var(--text)', letterSpacing: '-0.02em' }}>
            {task.title}
          </div>
          <div style={{
            marginTop: 5,
            fontSize: 11,
            color: 'var(--text-secondary)',
            lineHeight: 1.45,
            display: '-webkit-box',
            WebkitLineClamp: 3,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}>
            {task.prompt}
          </div>
        </div>
        <span style={{
          paddingTop: 4,
          paddingRight: 8,
          paddingBottom: 4,
          paddingLeft: 8,
          borderRadius: 999,
          background: status.background,
          border: `1px solid ${status.border}`,
          color: status.color,
          fontSize: 10,
          fontWeight: 700,
          whiteSpace: 'nowrap',
        }}>
          {status.label}
        </span>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
        <BoardPill>{task.preferredRuntime === 'claude-code' ? 'Claude Code' : 'Codex'}</BoardPill>
        <BoardPill>{task.baseBranch}</BoardPill>
        {task.bindings.issueId ? <BoardPill>Issue #{task.bindings.issueId}</BoardPill> : null}
        {task.bindings.prId ? <BoardPill>PR #{task.bindings.prId}</BoardPill> : null}
      </div>

      {(task.blockedByTitles.length > 0 || task.runtimeSession || task.worktree) ? (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6, textAlign: 'left' }}>
          {task.blockedByTitles.length > 0 ? (
            <div style={{ fontSize: 10.5, color: 'var(--yellow)', lineHeight: 1.4 }}>
              Blocked by {task.blockedByTitles.slice(0, 2).join(' \u2022 ')}
            </div>
          ) : null}
          {task.runtimeSession ? (
            <div style={{ fontSize: 10.5, color: 'var(--text-secondary)', lineHeight: 1.4 }}>
              {task.runtimeSession.name} \u00b7 {task.runtimeSession.status}
            </div>
          ) : null}
          {task.worktree ? (
            <div style={{ fontSize: 10.5, color: 'var(--text-tertiary)', lineHeight: 1.4, fontFamily: '"SF Mono", ui-monospace, monospace' }}>
              {task.worktree.branch}
            </div>
          ) : null}
        </div>
      ) : null}

      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        marginTop: 12,
      }}>
        <div style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>
          Updated {relativeAge(task.updatedAt)}
        </div>

        <div style={{ display: 'flex', gap: 6 }}>
          {task.columnId === 'backlog' && task.startable ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onStartTask(task.id);
              }}
              disabled={startBusyTaskId === task.id}
              style={miniActionButtonStyle('primary')}
            >
              {startBusyTaskId === task.id ? <RefreshCw size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <Play size={12} />}
              Start
            </button>
          ) : null}
          {task.columnId === 'in_progress' && task.reviewReady ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onMarkReviewReady(task.id);
              }}
              style={miniActionButtonStyle('secondary')}
            >
              <ChevronRight size={12} />
              Review
            </button>
          ) : null}
          {task.columnId === 'review' ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onArchiveTask(task.id, 'completed');
              }}
              style={miniActionButtonStyle('secondary')}
            >
              <Trash2 size={12} />
              Archive
            </button>
          ) : null}
          {task.columnId === 'trash' ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onRestoreTask(task.id);
              }}
              style={miniActionButtonStyle('secondary')}
            >
              <RotateCcw size={12} />
              Restore
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export const TaskCard = memo(TaskCardBase);
