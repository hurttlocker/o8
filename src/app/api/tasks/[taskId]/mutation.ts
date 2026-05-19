import { NextResponse, type NextRequest } from 'next/server';

import { requirePanelAuth } from '@/lib/panel/auth';
import { TaskMutationError, type TaskMutationResult } from '@/lib/tasks/actions';

type TaskMutationBody = Record<string, unknown>;
type TaskMutationContext = { params: Promise<{ taskId: string }> };
type TaskMutationHandler = (taskId: string, body: TaskMutationBody) => Promise<TaskMutationResult>;

export async function runTaskMutationRoute(
  request: NextRequest,
  context: TaskMutationContext,
  handler: TaskMutationHandler,
) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const { taskId } = await context.params;
  if (!taskId?.trim()) {
    return NextResponse.json({ error: 'taskId is required' }, { status: 400 });
  }

  const body = await request.json().catch(() => ({})) as TaskMutationBody;

  try {
    const result = await handler(taskId, body);
    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Task mutation failed.';
    const status = error instanceof TaskMutationError ? error.status : 500;
    return NextResponse.json(
      { error: message },
      { status, headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  }
}
