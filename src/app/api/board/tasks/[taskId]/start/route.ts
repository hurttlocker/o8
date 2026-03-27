import { NextRequest, NextResponse } from 'next/server';
import { getStartableTaskIds, getBoardSnapshot, loadBoardState, updateBoardState } from '@/lib/board/state';
import { launchRuntimeSurface } from '@/lib/runtime/actions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function buildLaunchPrompt(task: Awaited<ReturnType<typeof loadBoardState>>['tasks'][string]) {
  if (!task.automation.startInPlanMode) {
    return task.prompt;
  }

  return [
    'This Cortex board task is starting in plan mode.',
    'First produce a bounded implementation plan before you edit code.',
    '',
    task.prompt,
  ].join('\n');
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ taskId: string }> },
) {
  const body = (await request.json().catch(() => null)) as { repo?: string | null } | null;
  const repo = body?.repo?.trim();
  const { taskId } = await context.params;

  if (!repo) {
    return NextResponse.json({ error: 'repo is required' }, { status: 400 });
  }
  if (!taskId?.trim()) {
    return NextResponse.json({ error: 'taskId is required' }, { status: 400 });
  }

  try {
    const state = await loadBoardState(repo);
    const task = state.tasks[taskId];
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const taskColumnId = state.columns.find((column) => column.taskIds.includes(taskId))?.id ?? null;
    if (taskColumnId !== 'backlog') {
      return NextResponse.json({ error: 'Only backlog tasks can be started from the board.' }, { status: 409 });
    }

    if (
      task.bindings.runtime
      || task.bindings.runtimeSurfaceId
      || task.bindings.sessionId
      || task.bindings.worktreeId
      || task.bindings.worktreePath
    ) {
      return NextResponse.json(
        { error: 'This task still carries an active runtime/worktree binding. Restore should clear it before restart.' },
        { status: 409 },
      );
    }
    const startableTaskIds = new Set(getStartableTaskIds(state));
    if (!startableTaskIds.has(taskId)) {
      return NextResponse.json({ error: 'This task is blocked by unresolved dependencies.' }, { status: 409 });
    }

    const launch = await launchRuntimeSurface({
      runtime: task.preferredRuntime,
      repoPath: state.repoPath,
      cwd: state.repoPath,
      prompt: buildLaunchPrompt(task),
      taskName: task.title,
      baseBranch: task.baseBranch,
      isolate: true,
    });

    await updateBoardState(repo, (draft) => {
      const currentTask = draft.tasks[taskId];
      if (!currentTask) {
        return draft;
      }
      const runtimeId = launch.runtime === 'claude-code' ? 'claude-code' : 'codex';

      draft.tasks[taskId] = {
        ...currentTask,
        workflowState: 'running',
        archiveReason: null,
        archivedAt: null,
        archivedFromColumn: null,
        archivedRuntime: null,
        updatedAt: new Date().toISOString(),
        bindings: {
          ...currentTask.bindings,
          runtime: runtimeId,
          runtimeSurfaceId: launch.surfaceId,
          sessionId: launch.surfaceId,
          worktreeId: launch.worktree?.id ?? currentTask.bindings.worktreeId ?? null,
          worktreePath: launch.worktree?.path ?? currentTask.bindings.worktreePath ?? null,
        },
      };

      for (const column of draft.columns) {
        column.taskIds = column.taskIds.filter((id) => id !== taskId);
      }
      const inProgress = draft.columns.find((column) => column.id === 'in_progress');
      inProgress?.taskIds.unshift(taskId);
      return draft;
    });

    const snapshot = await getBoardSnapshot(repo);
    return NextResponse.json(
      {
        launch,
        snapshot,
      },
      {
        headers: {
          'Cache-Control': 'no-store, max-age=0',
        },
      },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to start board task' },
      { status: 500 },
    );
  }
}
