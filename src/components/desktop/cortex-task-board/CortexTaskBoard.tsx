'use client';

import {
  AlertCircle,
  Plus,
  RefreshCw,
} from '../lucide-shims';
import {
  emptyStateStyle,
  errorBannerStyle,
  sidePanelStyle,
  panelHeaderStyle,
  panelEyebrowStyle,
  panelTitleStyle,
  closeButtonStyle,
  secondaryButtonStyle,
} from './constants';
import { useTaskBoard } from './useTaskBoard';
import { BoardToolbar } from './BoardToolbar';
import { BoardForm } from './shared';
import { TaskColumn } from './TaskColumn';
import { DependencyOverlay } from './DependencyOverlay';
import { TaskWorkspace } from './TaskWorkspace';

export function CortexTaskBoard({
  repoPath,
  repoName,
}: {
  repoPath?: string | null;
  repoName?: string | null;
}) {
  const board = useTaskBoard(repoPath);

  if (!repoPath) {
    return (
      <div style={emptyStateStyle}>
        <AlertCircle size={16} />
        <span>Select a repo in Cortex before opening the operator board.</span>
      </div>
    );
  }

  if (board.loading && !board.snapshot) {
    return (
      <div style={emptyStateStyle}>
        <RefreshCw size={16} style={{ animation: 'spin 1s linear infinite' }} />
        <span>Loading Cortex board...</span>
      </div>
    );
  }

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      minHeight: 0,
      gap: 14,
    }}>
      <BoardToolbar
        repoName={repoName}
        repoPath={repoPath}
        snapshot={board.snapshot}
        refreshing={board.refreshing}
        backlogIssueCount={board.backlogIssues.length}
        onRefresh={() => void board.readSnapshot({ silent: true })}
      />

      {board.error ? (
        <div style={errorBannerStyle}>
          <AlertCircle size={15} />
          <span>{board.error}</span>
        </div>
      ) : null}

      <div style={{
        display: 'grid',
        gridTemplateColumns: board.composerOpen ? 'minmax(280px, 320px) minmax(0, 1fr)' : 'minmax(0, 1fr)',
        gap: 14,
        minHeight: 0,
        flex: 1,
      }}>
        {board.composerOpen ? (
          <div style={sidePanelStyle}>
            <div style={panelHeaderStyle}>
              <div>
                <div style={panelEyebrowStyle}>Task Composer</div>
                <strong style={panelTitleStyle}>Create Board Task</strong>
              </div>
              <button
                type="button"
                onClick={() => board.setComposerOpen(false)}
                style={closeButtonStyle}
              >
                ×
              </button>
            </div>

            <BoardForm
              value={board.composer}
              availableRuntimes={board.availableRuntimes}
              onChange={board.setComposer}
            />

            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button
                type="button"
                onClick={() => void board.handleCreateTask()}
                disabled={board.mutationBusy === 'create_task'}
                className="button-primary board-task-action-button"
              >
                <Plus size={14} />
                Create task
              </button>
              <button
                type="button"
                onClick={() => board.setComposerOpen(false)}
                style={secondaryButtonStyle}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1.45fr) minmax(420px, 1.12fr)',
          gap: 14,
          minHeight: 0,
        }}>
          <div
            ref={board.boardSurfaceRef}
            style={{
              position: 'relative',
              display: 'grid',
              gridTemplateColumns: 'repeat(4, minmax(220px, 1fr))',
              gap: 12,
              minHeight: 0,
            }}
          >
            <DependencyOverlay
              renderedDependencies={board.renderedDependencies}
              renderedDraftDependency={board.renderedDraftDependency}
              dependencyLayout={board.dependencyLayout}
              onRemoveDependency={(id) => void board.handleRemoveDependency(id)}
            />

            {board.snapshot?.columns.map((column) => (
              <TaskColumn
                key={column.id}
                column={column}
                backlogIssues={board.backlogIssues}
                issuesLoading={board.issuesLoading}
                issuesError={board.issuesError}
                selectedIssue={board.selectedIssue}
                selectedTaskId={board.selectedTaskId}
                dragTaskId={board.dragTaskId}
                dropTarget={board.dropTarget}
                dependencyDraft={board.dependencyDraft}
                startBusyTaskId={board.startBusyTaskId}
                issueStartBusyNumber={board.issueStartBusyNumber}
                mutationBusy={board.mutationBusy}
                onSelectTask={board.selectTask}
                onSelectIssue={board.selectIssue}
                onDragStart={board.setDragTaskId}
                onDragEnd={() => {
                  board.setDragTaskId(null);
                  board.setDropTarget(null);
                }}
                onSetDropTarget={board.setDropTarget}
                onTaskDrop={(taskId, colId, idx) => void board.handleTaskDrop(taskId, colId, idx)}
                onDependencyDraftStart={(taskId, clientX, clientY) => {
                  board.setDependencyDraft({
                    sourceTaskId: taskId,
                    targetTaskId: null,
                    pointerClientX: clientX,
                    pointerClientY: clientY,
                  });
                }}
                onStartTask={(id) => void board.handleStartTask(id)}
                onStartIssue={(issue) => void board.handleStartIssue(issue)}
                onMarkReviewReady={(id) => void board.handleMarkReviewReady(id)}
                onArchiveTask={(id, reason) => void board.handleArchiveTask(id, reason)}
                onRestoreTask={(id) => void board.handleRestoreTask(id)}
                onRefreshIssues={() => void board.readIssues()}
              />
            ))}
          </div>

          <TaskWorkspace
            selectedTask={board.selectedTask}
            selectedIssue={board.selectedIssue}
            selectedTaskStatus={board.selectedTaskStatus}
            editor={board.editor}
            availableRuntimes={board.availableRuntimes}
            snapshot={board.snapshot}
            allTasks={board.allTasks}
            dependencyOptions={board.dependencyOptions}
            dependencyTargetId={board.dependencyTargetId}
            startBusyTaskId={board.startBusyTaskId}
            issueStartBusyNumber={board.issueStartBusyNumber}
            mutationBusy={board.mutationBusy}
            reviewSnapshot={board.reviewSnapshot}
            reviewLoading={board.reviewLoading}
            reviewError={board.reviewError}
            onSetEditor={board.setEditor}
            onSetDependencyTargetId={board.setDependencyTargetId}
            onStartTask={(id) => void board.handleStartTask(id)}
            onStartIssue={(issue) => void board.handleStartIssue(issue)}
            onMarkReviewReady={(id) => void board.handleMarkReviewReady(id)}
            onArchiveTask={(id, reason) => void board.handleArchiveTask(id, reason)}
            onRestoreTask={(id) => void board.handleRestoreTask(id)}
            onSaveTask={() => void board.handleSaveTask()}
            onAddDependency={() => void board.handleAddDependency()}
            onRemoveDependency={(id) => void board.handleRemoveDependency(id)}
            onRefreshReview={() => void board.refreshReview()}
          />
        </div>
      </div>
    </div>
  );
}
