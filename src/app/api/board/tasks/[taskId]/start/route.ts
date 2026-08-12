import { NextRequest, NextResponse } from 'next/server';
import { getStartableTaskIds, getBoardSnapshot, loadBoardState, updateBoardState } from '@/lib/board/state';
import { launchRuntimeSurface } from '@/lib/runtime/actions';
import type { RuntimeLaunchResult } from '@/lib/runtime/actions';
import {
  bindIdempotencyClientMutation,
  deriveIdempotencyKey,
  withIdempotency,
} from '@/lib/orchestrator/idempotency-store';
import { findOwnedLaunchByMutationId } from '@/lib/runtimes/shared/owned-session-index';
import { listLanes } from '@/lib/lane/registry';

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
  const body = (await request.json().catch(() => null)) as {
    repo?: string | null;
    clientMutationId?: string | null;
  } | null;
  const repo = body?.repo?.trim();
  const clientMutationId = body?.clientMutationId?.trim();
  const { taskId } = await context.params;

  if (!repo) {
    return NextResponse.json({ error: 'repo is required' }, { status: 400 });
  }
  if (!taskId?.trim()) {
    return NextResponse.json({ error: 'taskId is required' }, { status: 400 });
  }
  if (!clientMutationId) {
    return NextResponse.json({ error: 'clientMutationId is required' }, { status: 400 });
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

    const launchRequest = {
      runtime: task.preferredRuntime,
      repoPath: state.repoPath,
      cwd: state.repoPath,
      prompt: buildLaunchPrompt(task),
      taskName: task.title,
      baseBranch: task.baseBranch,
      isolate: true,
      clientMutationId,
    } as const;
    const canonicalBody = JSON.stringify({ repo, taskId, launchRequest });
    const binding = bindIdempotencyClientMutation({
      namespace: 'board_task_start',
      clientKey: clientMutationId,
      body: canonicalBody,
    });
    if (binding.status === 'conflict') {
      return NextResponse.json({ error: 'clientMutationId was used for another board task start' }, { status: 409 });
    }
    if (binding.status === 'unavailable') {
      return NextResponse.json({ error: 'The board task start receipt store is unavailable' }, { status: 503 });
    }
    const settleBoardLaunch = async (launch: RuntimeLaunchResult) => {
      if (!launch.ok || !launch.surfaceId) {
        return { ok: false, launch, snapshot: await getBoardSnapshot(repo) };
      }
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

      return { ok: true, launch, snapshot: await getBoardSnapshot(repo) };
    };
    const outcome = await withIdempotency({
      key: deriveIdempotencyKey({
        verb: 'board_task_start',
        scopeId: `${repo}:${taskId}`,
        clientKey: clientMutationId,
        body: canonicalBody,
      }),
      verb: 'board_task_start',
      scopeId: `${repo}:${taskId}`,
      reconcileUnresolved: async () => {
        const owned = await findOwnedLaunchByMutationId(clientMutationId);
        if (!owned) return null;
        const lane = listLanes().find((candidate) => candidate.sessionKey === owned.surfaceId);
        if (!lane) return null;
        return settleBoardLaunch({
          ok: owned.outcome !== 'failed',
          runtime: task.preferredRuntime,
          clientMutationId,
          surfaceId: owned.surfaceId,
          note: 'Recovered the board task launch from its durable owned-session record.',
          cwd: owned.cwd,
          repoPath: owned.repoPath,
          worktree: null,
          laneId: lane.id,
        });
      },
    }, async () => {
      const launch = await launchRuntimeSurface(launchRequest);
      try {
        return await settleBoardLaunch(launch);
      } catch (error) {
        return {
          ok: false,
          launch: { ...launch, ok: false, note: error instanceof Error ? error.message : 'Board binding did not settle.' },
          snapshot: await getBoardSnapshot(repo),
          outcomeUnknown: true,
        };
      }
    });
    const outcomeUnknown = ('outcomeUnknown' in outcome.result && outcome.result.outcomeUnknown === true)
      || (outcome.inProgress && outcome.unresolved === true);
    return NextResponse.json(
      {
        ...outcome.result,
        replayed: outcome.replayed || undefined,
        inProgress: outcome.inProgress || undefined,
        outcomeUnknown: outcomeUnknown || undefined,
        ...(outcomeUnknown ? { error: 'The prior task launch outcome cannot be reconstructed. Inspect the board task and its lane before taking another action.' } : {}),
      },
      {
        status: outcomeUnknown ? 409 : outcome.inProgress ? 202 : outcome.result.ok ? 200 : 409,
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
