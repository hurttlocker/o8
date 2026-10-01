import type { TaskMutationPayload } from './types';

export type TaskExecutionRuntime = 'codex' | 'cloud';

export async function createTaskRequest(input: {
  title: string;
  summary: string | null;
  projectId: string;
  repoPath: string | null;
  workerIntent: string;
  requestedRuntime: TaskExecutionRuntime;
  model?: string | null;
}, dispatchAfterCreate: boolean): Promise<string> {
  const response = await fetch('/api/tasks', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  });
  const payload = await response.json().catch(() => ({})) as Partial<TaskMutationPayload> & { error?: string };
  if (!response.ok || payload.ok === false || !payload.taskId) {
    throw new Error(payload.error ?? payload.note ?? 'Task creation failed.');
  }
  if (!dispatchAfterCreate) return payload.note ?? 'Task added to ready pool.';
  const dispatchResponse = await fetch(`/api/tasks/${encodeURIComponent(payload.taskId)}/dispatch`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ actor: 'orchestrator', projectId: input.projectId, repoPath: input.repoPath }),
  });
  const dispatched = await dispatchResponse.json().catch(() => ({})) as Partial<TaskMutationPayload> & { error?: string };
  if (!dispatchResponse.ok || dispatched.ok === false) {
    throw new Error(dispatched.error ?? dispatched.note ?? 'Dispatch failed.');
  }
  return dispatched.note ?? 'Task created and dispatched.';
}
