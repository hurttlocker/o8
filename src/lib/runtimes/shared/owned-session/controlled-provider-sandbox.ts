import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { findTaskDraft } from '@/lib/mcp/task-draft-store';
import { controlledProviderPins } from './controlled-provider';
import type { OwnedSessionRecord } from './types';

/** External-provider tasks can read the approved files, never native login state. */
export function controlledProviderSandbox(session: OwnedSessionRecord, binary: string) {
  if (!session.controlledTask || !controlledProviderPins(session.model, session.effort, session.runtimeConfig)) return undefined;
  const draft = findTaskDraft(session.controlledTask.taskId);
  if (draft.contractHash !== session.controlledTask.contractHash) throw new Error('Controlled task contract changed.');
  return {
    finalDenyPaths: [homedir(), tmpdir(), '/tmp', '/private/tmp', getDataDir()],
    finalAllowReadPaths: [binary, session.repoPath, ...draft.contract.allowedFiles.map((file) => join(session.repoPath, file))],
    finalDenyExecNamePrefixes: ['codex', 'opencode', 'claude', 'bash', 'zsh', 'sh', 'python', 'node'],
    finalAllowExecPaths: [binary],
  };
}
