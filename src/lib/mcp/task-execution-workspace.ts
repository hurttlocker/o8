import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { taskDraftGit } from './task-draft-git';
import { TaskDraftError } from './task-draft-contract';
import { taskDraftRoot, type TaskDraftRecord } from './task-draft-store';
import { captureTaskDraftWorkspace, captureTaskWorkspacePath, verifyFiles } from './task-draft-workspace';
import type { TaskExecutionRecord } from './task-execution-store';

async function git(path: string, args: string[]): Promise<string> {
  return (await taskDraftGit(path, args)).trim();
}
export async function verifyTaskSource(draft: TaskDraftRecord): Promise<void> {
  const fresh = await captureTaskDraftWorkspace(draft.contract.repoId, draft.contract.projectId);
  if (fresh.repoPath !== draft.snapshot.repoPath || fresh.revision !== draft.snapshot.revision
    || fresh.rulesDigest !== draft.snapshot.rulesDigest) throw new TaskDraftError('workspace_changed', 409);
  verifyFiles(fresh.repoPath, draft.contract.allowedFiles);
}
export async function prepareTaskExecutionWorkspace(draft: TaskDraftRecord, record: TaskExecutionRecord): Promise<void> {
  await verifyTaskSource(draft);
  if (existsSync(record.workspacePath)) throw new TaskDraftError('execution_uncertain', 409);
  mkdirSync(join(taskDraftRoot(), 'workspaces'), { recursive: true, mode: 0o700 });
  // No fetch, rebase, environment copies, dependency materialization or setup scripts.
  await git(draft.snapshot.repoPath, ['worktree', 'add', '--detach', record.workspacePath, draft.snapshot.revision]);
  await verifyTaskExecutionWorkspace(draft, record);
}
export async function verifyTaskExecutionWorkspace(draft: TaskDraftRecord, record: TaskExecutionRecord): Promise<void> {
  await verifyTaskSource(draft);
  try {
    if (realpathSync(record.workspacePath) !== record.workspacePath || record.workspacePath === draft.snapshot.repoPath) throw new Error('Not isolated');
    const common = async (path: string) => realpathSync(resolve(path, await git(path, ['rev-parse', '--git-common-dir'])));
    if (await common(record.workspacePath) !== await common(draft.snapshot.repoPath)
      || await git(record.workspacePath, ['rev-parse', '--abbrev-ref', 'HEAD']) !== 'HEAD') throw new Error('Wrong worktree');
    const fresh = await captureTaskWorkspacePath(record.workspacePath);
    if (fresh.revision !== draft.snapshot.revision || fresh.rulesDigest !== draft.snapshot.rulesDigest) throw new Error('Changed worktree');
    verifyFiles(record.workspacePath, draft.contract.allowedFiles);
    for (const file of draft.contract.allowedFiles) {
      if (!readFileSync(join(record.workspacePath, file)).equals(readFileSync(join(draft.snapshot.repoPath, file)))) {
        throw new Error('Configured transforms changed the requested file bytes');
      }
    }
  } catch { throw new TaskDraftError('workspace_changed', 409); }
}
