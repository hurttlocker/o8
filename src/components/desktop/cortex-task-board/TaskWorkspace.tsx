'use client';

import { memo } from 'react';
import {
  ChevronRight,
  ExternalLink,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
} from '../lucide-shims';
import { WorkflowReviewPanel } from '@/components/workflow-review-panel';
import type { TaskWorkspaceProps } from './types';
import {
  archiveReasonLabel,
  compactPath,
  relativeAge,
  runtimeStatusClass,
  taskReviewLabel,
  taskStatusClass,
  taskWorkspaceSummary,
} from './utils';
import { BoardForm, BoardPill, DependencyRow } from './shared';

function TaskWorkspaceBase({
  selectedTask,
  selectedIssue,
  selectedTaskStatus,
  editor,
  availableRuntimes,
  snapshot,
  allTasks,
  dependencyOptions,
  dependencyTargetId,
  startBusyTaskId,
  issueStartBusyNumber,
  mutationBusy,
  reviewSnapshot,
  reviewLoading,
  reviewError,
  onSetEditor,
  onSetDependencyTargetId,
  onStartTask,
  onStartIssue,
  onMarkReviewReady,
  onArchiveTask,
  onRestoreTask,
  onSaveTask,
  onAddDependency,
  onRemoveDependency,
  onRefreshReview,
}: TaskWorkspaceProps) {
  return (
    <aside className="surface-card board-task-workspace-shell">
      <div className="section-head">
        <div>
          <div className="eyebrow">Task workspace</div>
          <h2>{selectedTask?.title ?? 'Select a task'}</h2>
        </div>
        {selectedTask ? (
          <span className={`status-pill ${taskStatusClass(selectedTask)}`}>
            {selectedTaskStatus?.label ?? selectedTask.columnId.replace('_', ' ')}
          </span>
        ) : null}
      </div>

      {!selectedTask && !selectedIssue ? (
        <div className="board-task-empty">
          <Plus size={16} />
          <span>Select a card to open its task desk.</span>
        </div>
      ) : selectedIssue && !selectedTask ? (
        <IssueWorkspace
          selectedIssue={selectedIssue}
          issueStartBusyNumber={issueStartBusyNumber}
          onStartIssue={onStartIssue}
        />
      ) : selectedTask && editor ? (
        <TaskDetailWorkspace
          selectedTask={selectedTask}
          selectedTaskStatus={selectedTaskStatus}
          editor={editor}
          availableRuntimes={availableRuntimes}
          snapshot={snapshot}
          allTasks={allTasks}
          dependencyOptions={dependencyOptions}
          dependencyTargetId={dependencyTargetId}
          startBusyTaskId={startBusyTaskId}
          mutationBusy={mutationBusy}
          reviewSnapshot={reviewSnapshot}
          reviewLoading={reviewLoading}
          reviewError={reviewError}
          onSetEditor={onSetEditor}
          onSetDependencyTargetId={onSetDependencyTargetId}
          onStartTask={onStartTask}
          onMarkReviewReady={onMarkReviewReady}
          onArchiveTask={onArchiveTask}
          onRestoreTask={onRestoreTask}
          onSaveTask={onSaveTask}
          onAddDependency={onAddDependency}
          onRemoveDependency={onRemoveDependency}
          onRefreshReview={onRefreshReview}
        />
      ) : (
        <div className="board-task-empty">
          <RefreshCw size={16} style={{ animation: 'spin 1s linear infinite' }} />
          <span>Preparing the selected workspace...</span>
        </div>
      )}
    </aside>
  );
}

export const TaskWorkspace = memo(TaskWorkspaceBase);

/* ------------------------------------------------------------------ */
/*  Issue workspace (when a backlog issue is selected, not a task)     */
/* ------------------------------------------------------------------ */

function IssueWorkspaceBase({
  selectedIssue,
  issueStartBusyNumber,
  onStartIssue,
}: Pick<TaskWorkspaceProps, 'selectedIssue' | 'issueStartBusyNumber' | 'onStartIssue'>) {
  if (!selectedIssue) return null;

  return (
    <div className="board-task-workspace">
      <div className="inset-card inspector-block tool-shell board-task-strip">
        <div className="row space-between compact-row operator-header-row">
          <div>
            <span>Repo issue</span>
            <strong>{`#${selectedIssue.number} ${selectedIssue.title}`}</strong>
          </div>
          <span className="status-pill status-stable">{relativeAge(selectedIssue.updatedAt)}</span>
        </div>

        <p className="muted operator-note">
          Backlog is now repo-issue first. Start the issue to create a truthful board task with a real runtime and worktree.
        </p>

        <div className="board-task-chip-row">
          <BoardPill>{selectedIssue.state}</BoardPill>
          <BoardPill>{selectedIssue.comments} comments</BoardPill>
          {selectedIssue.labels.slice(0, 4).map((label) => (
            <BoardPill key={`selected-issue-${selectedIssue.number}-${label.name}`}>{label.name}</BoardPill>
          ))}
        </div>

        <div className="board-task-action-row">
          <button
            type="button"
            onClick={() => void onStartIssue(selectedIssue)}
            disabled={issueStartBusyNumber === selectedIssue.number}
            className="button-primary board-task-action-button"
          >
            {issueStartBusyNumber === selectedIssue.number ? <RefreshCw size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Play size={14} />}
            Start issue
          </button>
          <a
            href={selectedIssue.url}
            target="_blank"
            rel="noreferrer"
            className="board-task-link"
          >
            <ExternalLink size={14} />
            Open on GitHub
          </a>
        </div>
      </div>

      <div className="board-task-grid">
        <div className="board-task-primary">
          <div className="surface-card board-task-review-empty">
            <div className="section-head">
              <div>
                <div className="eyebrow">Issue context</div>
                <h2>Implementation brief</h2>
              </div>
            </div>
            <div className="workflow-file-list">
              <div className="workflow-file-item">
                <div className="row space-between compact-row">
                  <strong>Description</strong>
                  <span className="muted">{selectedIssue.author?.login ? `Opened by ${selectedIssue.author.login}` : 'GitHub issue'}</span>
                </div>
                <p className="muted">
                  {selectedIssue.body?.trim() || 'No issue body was provided.'}
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="board-task-secondary">
          <div className="inset-card inspector-block tool-shell">
            <div className="row space-between compact-row operator-header-row">
              <div>
                <span>Queue state</span>
                <strong>Repo issue waiting in backlog</strong>
              </div>
              <span className="status-pill status-stable">not started</span>
            </div>
            <p className="muted operator-note">
              This issue is not a live task yet. Starting it creates the board task, binds the issue number, and launches the real runtime path.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

const IssueWorkspace = memo(IssueWorkspaceBase);

/* ------------------------------------------------------------------ */
/*  Task detail workspace (when a real board task is selected)         */
/* ------------------------------------------------------------------ */

type TaskDetailWorkspaceProps = Omit<TaskWorkspaceProps,
  'selectedIssue' | 'issueStartBusyNumber' | 'onStartIssue'
>;

function TaskDetailWorkspaceBase({
  selectedTask,
  selectedTaskStatus,
  editor,
  availableRuntimes,
  snapshot,
  allTasks,
  dependencyOptions,
  dependencyTargetId,
  startBusyTaskId,
  mutationBusy,
  reviewSnapshot,
  reviewLoading,
  reviewError,
  onSetEditor,
  onSetDependencyTargetId,
  onStartTask,
  onMarkReviewReady,
  onArchiveTask,
  onRestoreTask,
  onSaveTask,
  onAddDependency,
  onRemoveDependency,
  onRefreshReview,
}: TaskDetailWorkspaceProps) {
  if (!selectedTask || !editor) return null;

  return (
    <div className="board-task-workspace">
      <div className="inset-card inspector-block tool-shell board-task-strip">
        <div className="row space-between compact-row operator-header-row">
          <div>
            <span>Task desk</span>
            <strong>{selectedTask.title}</strong>
          </div>
          <div className="board-task-status-group">
            <span className={`status-pill ${taskStatusClass(selectedTask)}`}>
              {selectedTaskStatus?.label ?? selectedTask.columnId.replace('_', ' ')}
            </span>
            <span className={`status-pill ${runtimeStatusClass(selectedTask.runtimeSession?.status)}`}>
              {selectedTask.runtimeSession?.status ?? (selectedTask.archivedRuntime ? 'archived lane' : 'not started')}
            </span>
          </div>
        </div>

        <p className="muted operator-note">{taskWorkspaceSummary(selectedTask)}</p>

        <div className="board-task-chip-row">
          <BoardPill>{selectedTask.columnId.replace('_', ' ')}</BoardPill>
          <BoardPill>{selectedTask.preferredRuntime === 'claude-code' ? 'Claude Code' : 'Codex'}</BoardPill>
          <BoardPill>{selectedTask.baseBranch}</BoardPill>
          {selectedTask.bindings.issueId ? <BoardPill>Issue #{selectedTask.bindings.issueId}</BoardPill> : null}
          {selectedTask.bindings.prId ? <BoardPill>PR #{selectedTask.bindings.prId}</BoardPill> : null}
          {selectedTask.columnId === 'trash' ? <BoardPill>{archiveReasonLabel(selectedTask.archiveReason)}</BoardPill> : null}
          {selectedTask.worktree ? <BoardPill>{selectedTask.worktree.branch}</BoardPill> : null}
          {selectedTask.archivedRuntime?.worktreeId ? <BoardPill>Archived lane</BoardPill> : null}
        </div>

        <div className="board-task-action-row">
          {selectedTask.columnId === 'backlog' && selectedTask.startable ? (
            <button
              type="button"
              onClick={() => void onStartTask(selectedTask.id)}
              disabled={startBusyTaskId === selectedTask.id}
              className="button-primary board-task-action-button"
            >
              {startBusyTaskId === selectedTask.id ? <RefreshCw size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Play size={14} />}
              Start task
            </button>
          ) : null}

          {selectedTask.columnId === 'in_progress' ? (
            <button
              type="button"
              onClick={() => void onMarkReviewReady(selectedTask.id)}
              disabled={!selectedTask.reviewReady || mutationBusy === 'mark_review_ready'}
              className="board-task-action-button"
            >
              <ChevronRight size={14} />
              {selectedTask.reviewReady ? 'Mark review-ready' : 'Awaiting review signal'}
            </button>
          ) : null}

          {selectedTask.columnId === 'review' ? (
            <button
              type="button"
              onClick={() => void onArchiveTask(selectedTask.id, 'completed')}
              disabled={mutationBusy === 'archive_task'}
              className="board-task-action-button"
            >
              <Trash2 size={14} />
              Archive to trash
            </button>
          ) : null}

          {(selectedTask.columnId === 'backlog' || selectedTask.columnId === 'in_progress') ? (
            <button
              type="button"
              onClick={() => void onArchiveTask(selectedTask.id, 'discarded')}
              disabled={mutationBusy === 'archive_task'}
              className="board-task-action-button board-task-action-button-danger"
            >
              <Trash2 size={14} />
              Discard
            </button>
          ) : null}

          {selectedTask.columnId === 'trash' ? (
            <button
              type="button"
              onClick={() => void onRestoreTask(selectedTask.id)}
              disabled={mutationBusy === 'restore_task'}
              className="board-task-action-button"
            >
              <RotateCcw size={14} />
              Restore to backlog
            </button>
          ) : null}

          {selectedTask.bindings.prId && snapshot?.state.repoSlug ? (
            <a
              href={`https://github.com/${snapshot.state.repoSlug}/pull/${selectedTask.bindings.prId}`}
              target="_blank"
              rel="noreferrer"
              className="board-task-link"
            >
              <ExternalLink size={14} />
              Open PR #{selectedTask.bindings.prId}
            </a>
          ) : null}
        </div>
      </div>

      <div className="board-task-grid">
        <div className="board-task-primary">
          {reviewSnapshot || reviewError ? (
            <WorkflowReviewPanel
              controlled
              initialSnapshot={reviewSnapshot}
              error={reviewError}
              onRefresh={onRefreshReview}
            />
          ) : (
            <div className="surface-card board-task-review-empty">
              <div className="section-head">
                <div>
                  <div className="eyebrow">Review surface</div>
                  <h2>Waiting for a real task-local worktree</h2>
                </div>
                <button
                  type="button"
                  onClick={() => void onRefreshReview()}
                  className="board-task-action-button"
                >
                  <RefreshCw size={14} style={reviewLoading ? { animation: 'spin 1s linear infinite' } : undefined} />
                  Refresh
                </button>
              </div>
              <div className="board-task-empty">
                <span>Start the task into a real worktree or refresh once the runtime reports review context.</span>
              </div>
            </div>
          )}
        </div>

        <div className="board-task-secondary">
          <RuntimeLaneCard
            selectedTask={selectedTask}
          />

          <DependenciesCard
            selectedTask={selectedTask}
            snapshot={snapshot}
            allTasks={allTasks}
            dependencyOptions={dependencyOptions}
            dependencyTargetId={dependencyTargetId}
            onSetDependencyTargetId={onSetDependencyTargetId}
            onAddDependency={onAddDependency}
            onRemoveDependency={onRemoveDependency}
          />

          <TaskBriefCard selectedTask={selectedTask} />

          <TaskEditorCard
            editor={editor}
            availableRuntimes={availableRuntimes}
            mutationBusy={mutationBusy}
            onSetEditor={onSetEditor}
            onSaveTask={onSaveTask}
          />
        </div>
      </div>
    </div>
  );
}

const TaskDetailWorkspace = memo(TaskDetailWorkspaceBase);

/* ------------------------------------------------------------------ */
/*  Runtime lane sub-card                                              */
/* ------------------------------------------------------------------ */

function RuntimeLaneCardBase({
  selectedTask,
}: { selectedTask: NonNullable<TaskWorkspaceProps['selectedTask']> }) {
  return (
    <div className="inset-card inspector-block tool-shell">
      <div className="row space-between compact-row operator-header-row">
        <div>
          <span>Runtime lane</span>
          <strong>Bindings, worktree, and resume truth</strong>
        </div>
        <span className={`status-pill ${selectedTask.runtimeSession ? runtimeStatusClass(selectedTask.runtimeSession.status) : selectedTask.archivedRuntime ? 'status-stable' : 'status-warning'}`}>
          {selectedTask.runtimeSession ? selectedTask.runtimeSession.status : selectedTask.archivedRuntime ? 'history only' : 'unbound'}
        </span>
      </div>

      <div className="operator-state-grid board-task-secondary-grid">
        <div className="operator-state-card">
          <span>Board state</span>
          <strong>{selectedTask.columnId.replace('_', ' ')}</strong>
          <p className="muted">{taskReviewLabel(selectedTask)}</p>
        </div>
        <div className="operator-state-card">
          <span>Live runtime</span>
          <strong>{selectedTask.runtimeSession?.name ?? 'Not attached'}</strong>
          <p className="muted mono">{selectedTask.bindings.runtimeSurfaceId ?? 'No runtime surface id'}</p>
        </div>
        <div className="operator-state-card">
          <span>Session / worktree</span>
          <strong>{selectedTask.bindings.sessionId ?? selectedTask.bindings.worktreeId ?? 'No active binding'}</strong>
          <p className="muted mono">
            {compactPath(selectedTask.bindings.worktreePath ?? selectedTask.worktree?.path) ?? 'No worktree path bound'}
          </p>
        </div>
        <div className="operator-state-card">
          <span>Review / PR</span>
          <strong>{selectedTask.bindings.prId ? `PR #${selectedTask.bindings.prId}` : 'No PR linked'}</strong>
          <p className="muted">
            {selectedTask.bindings.issueId
              ? `Issue #${selectedTask.bindings.issueId}`
              : selectedTask.reviewReady || selectedTask.columnId === 'review'
                ? 'Task is on the review path'
                : 'Review stays attached to the task worktree'}
          </p>
        </div>
        <div className="operator-state-card">
          <span>Restore model</span>
          <strong>{selectedTask.archivedRuntime ? 'Fresh restart only' : 'Direct start allowed'}</strong>
          <p className="muted">
            Archive converts live task bindings into history so restore never relaunches on top of stale execution.
          </p>
        </div>
      </div>

      <div className="workflow-file-list board-task-binding-list">
        {selectedTask.worktree ? (
          <div className="workflow-file-item">
            <div className="row space-between compact-row">
              <strong>Active worktree</strong>
              <span className="status-pill status-running">{selectedTask.worktree.status}</span>
            </div>
            <p className="muted mono">
              {selectedTask.worktree.branch}
              {' \u2022 '}
              {compactPath(selectedTask.worktree.path) ?? selectedTask.worktree.path}
            </p>
          </div>
        ) : null}

        {selectedTask.archivedRuntime ? (
          <div className="workflow-file-item">
            <div className="row space-between compact-row">
              <strong>Archived runtime snapshot</strong>
              <span className="status-pill status-stable">
                {selectedTask.archivedRuntime.archivedAt ? relativeAge(selectedTask.archivedRuntime.archivedAt) : 'history'}
              </span>
            </div>
            <p className="muted mono">
              {(selectedTask.archivedRuntime.runtime === 'claude-code' ? 'claude-code' : selectedTask.archivedRuntime.runtime === 'codex' ? 'codex' : 'runtime')}
              {' \u2022 '}
              {selectedTask.archivedRuntime.runtimeSurfaceId ?? selectedTask.archivedRuntime.sessionId ?? 'surface unavailable'}
              {' \u2022 '}
              {compactPath(selectedTask.archivedRuntime.worktreePath) ?? 'no archived worktree path'}
            </p>
          </div>
        ) : null}

        {!selectedTask.runtimeSession && !selectedTask.worktree && !selectedTask.archivedRuntime ? (
          <div className="board-task-empty board-task-empty-compact">
            <span>No task-local runtime or worktree is attached yet.</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

const RuntimeLaneCard = memo(RuntimeLaneCardBase);

/* ------------------------------------------------------------------ */
/*  Dependencies sub-card                                              */
/* ------------------------------------------------------------------ */

type DependenciesCardProps = Pick<TaskWorkspaceProps,
  'selectedTask' | 'snapshot' | 'allTasks' | 'dependencyOptions' |
  'dependencyTargetId' | 'onSetDependencyTargetId' | 'onAddDependency' | 'onRemoveDependency'
>;

function DependenciesCardBase({
  selectedTask,
  snapshot,
  allTasks,
  dependencyOptions,
  dependencyTargetId,
  onSetDependencyTargetId,
  onAddDependency,
  onRemoveDependency,
}: DependenciesCardProps) {
  if (!selectedTask) return null;

  return (
    <div className="inset-card inspector-block tool-shell">
      <div className="row space-between compact-row operator-header-row">
        <div>
          <span>Dependencies</span>
          <strong>Graph context survives restore</strong>
        </div>
        <span className="status-pill status-stable">
          {selectedTask.blockedByTaskIds.length + selectedTask.dependentTaskIds.length} links
        </span>
      </div>
      <p className="muted operator-note">
        Links stay persisted even while a task is archived. Only active backlog blockers can prevent a new start.
      </p>

      <div className="board-task-linker">
        <select
          value={dependencyTargetId}
          onChange={(event) => onSetDependencyTargetId(event.target.value)}
          className="board-task-select"
        >
          <option value="">Select task to link...</option>
          {dependencyOptions.map((option) => (
            <option key={option.id} value={option.id}>{option.label}</option>
          ))}
        </select>
        <button type="button" onClick={() => void onAddDependency()} className="board-task-action-button">
          <Plus size={14} />
          Link
        </button>
      </div>

      <div className="board-task-dependency-list">
        {selectedTask.blockedByTaskIds.map((taskId) => {
          const dependency = snapshot?.state.dependencies.find((item) => item.fromTaskId === selectedTask.id && item.toTaskId === taskId);
          const label = allTasks.find((task) => task.id === taskId)?.title ?? taskId;
          return (
            <DependencyRow
              key={dependency?.id ?? `blocked-${taskId}`}
              label={`Depends on ${label}`}
              onRemove={dependency ? () => void onRemoveDependency(dependency.id) : undefined}
            />
          );
        })}
        {selectedTask.dependentTaskIds.map((taskId) => {
          const dependency = snapshot?.state.dependencies.find((item) => item.toTaskId === selectedTask.id && item.fromTaskId === taskId);
          const label = allTasks.find((task) => task.id === taskId)?.title ?? taskId;
          return (
            <DependencyRow
              key={dependency?.id ?? `dependent-${taskId}`}
              label={`${label} depends on this`}
              onRemove={dependency ? () => void onRemoveDependency(dependency.id) : undefined}
            />
          );
        })}
        {selectedTask.blockedByTaskIds.length === 0 && selectedTask.dependentTaskIds.length === 0 ? (
          <div className="board-task-empty board-task-empty-compact">
            <span>No dependency links yet.</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

const DependenciesCard = memo(DependenciesCardBase);

/* ------------------------------------------------------------------ */
/*  Task brief sub-card                                                */
/* ------------------------------------------------------------------ */

function TaskBriefCardBase({
  selectedTask,
}: { selectedTask: NonNullable<TaskWorkspaceProps['selectedTask']> }) {
  return (
    <div className="inset-card inspector-block tool-shell">
      <div className="row space-between compact-row operator-header-row">
        <div>
          <span>Task brief</span>
          <strong>Prompt, issue linkage, and metadata</strong>
        </div>
        <span className="status-pill status-stable">{selectedTask.automation.startInPlanMode ? 'plan first' : 'direct start'}</span>
      </div>
      <div className="workflow-file-list">
        <div className="workflow-file-item">
          <div className="row space-between compact-row">
            <strong>Prompt</strong>
            <span className="muted">{selectedTask.updatedAt ? `Updated ${relativeAge(selectedTask.updatedAt)}` : 'current'}</span>
          </div>
          <p className="muted">{selectedTask.prompt}</p>
        </div>
      </div>
    </div>
  );
}

const TaskBriefCard = memo(TaskBriefCardBase);

/* ------------------------------------------------------------------ */
/*  Task editor sub-card (collapsible details)                         */
/* ------------------------------------------------------------------ */

type TaskEditorCardProps = Pick<TaskWorkspaceProps,
  'editor' | 'availableRuntimes' | 'mutationBusy' | 'onSetEditor' | 'onSaveTask'
>;

function TaskEditorCardBase({
  editor,
  availableRuntimes,
  mutationBusy,
  onSetEditor,
  onSaveTask,
}: TaskEditorCardProps) {
  if (!editor) return null;

  return (
    <details className="inset-card inspector-block tool-shell board-task-editor-shell">
      <summary className="board-task-editor-summary">
        <div>
          <span>Edit task</span>
          <strong>Secondary metadata editor</strong>
        </div>
        <ChevronRight size={14} />
      </summary>
      <div className="board-task-editor-body">
        <p className="muted operator-note">
          Editing stays secondary to the task-local review and runtime desk. Change the brief here, then save it back into the board model.
        </p>
        <BoardForm
          value={editor}
          availableRuntimes={availableRuntimes}
          onChange={onSetEditor}
        />
        <div className="board-task-action-row">
          <button
            type="button"
            onClick={() => void onSaveTask()}
            disabled={mutationBusy === 'update_task'}
            className="button-primary board-task-action-button"
          >
            Save task
          </button>
        </div>
      </div>
    </details>
  );
}

const TaskEditorCard = memo(TaskEditorCardBase);
