'use client';

import { memo } from 'react';
import {
  ExternalLink,
  Play,
  RefreshCw,
} from 'lucide-react';
import type { TaskColumnProps } from './types';
import {
  columnStyle,
  panelHeaderStyle,
  panelEyebrowStyle,
  panelTitleStyle,
  columnCountStyle,
  columnIssueHeaderStyle,
  ghostButtonStyle,
  columnEmptyStyle,
} from './constants';
import { relativeAge } from './utils';
import { BoardPill } from './shared';
import { TaskCard } from './TaskCard';

function TaskColumnBase({
  column,
  backlogIssues,
  issuesLoading,
  issuesError,
  selectedIssue,
  selectedTaskId,
  dragTaskId,
  dropTarget,
  dependencyDraft,
  startBusyTaskId,
  issueStartBusyNumber,
  mutationBusy,
  onSelectTask,
  onSelectIssue,
  onDragStart,
  onDragEnd,
  onSetDropTarget,
  onTaskDrop,
  onDependencyDraftStart,
  onStartTask,
  onStartIssue,
  onMarkReviewReady,
  onArchiveTask,
  onRestoreTask,
  onRefreshIssues,
}: TaskColumnProps) {
  return (
    <div
      onDragOver={(event) => {
        event.preventDefault();
        if (dragTaskId) {
          onSetDropTarget({
            columnId: column.id,
            index: column.tasks.length,
          });
        }
      }}
      onDragLeave={() => {
        if (dropTarget?.columnId === column.id && dropTarget.index === column.tasks.length) {
          onSetDropTarget(null);
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        const taskId = event.dataTransfer.getData('text/plain') || dragTaskId;
        if (taskId) {
          onTaskDrop(taskId, column.id, column.tasks.length);
        }
      }}
      style={{
        ...columnStyle,
        position: 'relative',
        zIndex: 2,
        borderColor: dropTarget?.columnId === column.id ? 'rgba(59,130,246,0.4)' : 'var(--border)',
        boxShadow: dropTarget?.columnId === column.id
          ? '0 0 0 1px rgba(59,130,246,0.22), var(--shadow)'
          : 'var(--shadow)',
      }}
    >
      <div style={panelHeaderStyle}>
        <div>
          <div style={panelEyebrowStyle}>{column.id.replace('_', ' ')}</div>
          <strong style={panelTitleStyle}>{column.title}</strong>
        </div>
        <span style={columnCountStyle}>{column.tasks.length + (column.id === 'backlog' ? backlogIssues.length : 0)}</span>
      </div>

      {column.id === 'backlog' ? (
        <div style={columnIssueHeaderStyle}>
          <span>{issuesLoading ? 'Syncing repo issues...' : `${backlogIssues.length} open issues ready`}</span>
          <button
            type="button"
            onClick={() => onRefreshIssues()}
            style={ghostButtonStyle}
          >
            <RefreshCw size={12} style={issuesLoading ? { animation: 'spin 1s linear infinite' } : undefined} />
            Refresh issues
          </button>
        </div>
      ) : null}

      <div style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        overflowY: 'auto',
        paddingRight: 2,
        minHeight: 0,
        flex: 1,
      }}>
        {column.id === 'backlog' ? backlogIssues.map((issue) => {
          const isActiveIssue = selectedIssue?.number === issue.number;
          return (
            <button
              key={`issue-${issue.number}`}
              type="button"
              onClick={() => onSelectIssue(issue.number)}
              className={`workflow-file-item board-issue-card${isActiveIssue ? ' board-issue-card-active' : ''}`}
              style={{ textAlign: 'left' }}
            >
              <div className="row space-between compact-row">
                <strong>{`#${issue.number} ${issue.title}`}</strong>
                <span className="status-pill status-stable">{relativeAge(issue.updatedAt)}</span>
              </div>
              <p className="muted">
                {issue.body?.trim()
                  ? issue.body.trim().replace(/\s+/g, ' ').slice(0, 180)
                  : 'No issue body yet.'}
              </p>
              <div className="board-task-chip-row">
                <BoardPill>{issue.comments} comments</BoardPill>
                {issue.labels.slice(0, 2).map((label) => (
                  <BoardPill key={`${issue.number}-${label.name}`}>{label.name}</BoardPill>
                ))}
              </div>
              <div className="board-task-action-row">
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onStartIssue(issue);
                  }}
                  disabled={issueStartBusyNumber === issue.number}
                  className="button-primary board-task-action-button"
                >
                  {issueStartBusyNumber === issue.number ? <RefreshCw size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Play size={13} />}
                  Start issue
                </button>
                <a
                  href={issue.url}
                  target="_blank"
                  rel="noreferrer"
                  className="board-task-link"
                  onClick={(event) => event.stopPropagation()}
                >
                  <ExternalLink size={13} />
                  Open issue
                </a>
              </div>
            </button>
          );
        }) : null}

        {column.tasks.map((task, taskIndex) => (
          <TaskCard
            key={task.id}
            task={task}
            columnId={column.id}
            taskIndex={taskIndex}
            selectedTaskId={selectedTaskId}
            dragTaskId={dragTaskId}
            dropTarget={dropTarget}
            dependencyDraft={dependencyDraft}
            startBusyTaskId={startBusyTaskId}
            mutationBusy={mutationBusy}
            onSelect={onSelectTask}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onDragOver={(colId, idx) => onSetDropTarget({ columnId: colId, index: idx })}
            onDrop={(taskId, colId, idx) => onTaskDrop(taskId, colId, idx)}
            onDependencyDraftStart={onDependencyDraftStart}
            onStartTask={(id) => { void onStartTask(id); }}
            onMarkReviewReady={(id) => { void onMarkReviewReady(id); }}
            onArchiveTask={(id, reason) => { void onArchiveTask(id, reason); }}
            onRestoreTask={(id) => { void onRestoreTask(id); }}
          />
        ))}

        {column.tasks.length === 0 && (column.id !== 'backlog' || backlogIssues.length === 0) ? (
          <div style={columnEmptyStyle}>
            {column.id === 'backlog'
              ? issuesError
                ? `Issue queue unavailable: ${issuesError}`
                : 'Open repo issues appear here. Start one to create a real Cortex task and worktree.'
              : column.id === 'in_progress'
                ? 'Started tasks land here with runtime and worktree bindings.'
                : column.id === 'review'
                  ? 'Only real review-ready work can land here.'
                  : 'Archive keeps operator history with disposition, not silent deletion.'}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export const TaskColumn = memo(TaskColumnBase);
