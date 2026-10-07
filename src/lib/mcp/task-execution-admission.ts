import { controlledProviderConfig } from '@/lib/runtimes/shared/owned-session/controlled-provider';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readActiveIdentity } from '@/lib/github-broker/managed';
import { attachSession, setLaneStatus } from '@/lib/lane/registry';
import { ownedRoots } from '@/lib/runtimes/shared/owned-session-index';
import { probeOwnedRunMarker } from '@/lib/runtimes/shared/owned-session/run-process-proof';
import { archiveRootForOwnedSessionRoot } from '@/lib/runtimes/shared/owned-session/archive';
import type { OwnedLaunchRequest, OwnedRunRecord, OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session/types';
import { withTaskDraftAccountAdmission } from './task-draft-account';
import { canonical, TaskDraftError } from './task-draft-contract';
import { findTaskDraft } from './task-draft-store';
import { readTaskExecution, taskBinding, withTaskExecutionLock, writeTaskExecution,
  type ControlledTaskBinding, type TaskExecutionRecord } from './task-execution-store';
import { verifyTaskExecutionWorkspace } from './task-execution-workspace';

export const operatorAccount = () => ({ accountId: readActiveIdentity() ?? undefined, expiresAt: Infinity });
function launchAccount(record: TaskExecutionRecord) {
  return { accountId: record.account.accountId, expiresAt: record.pluginLaunchGrant?.expiresAt ?? Infinity };
}
function draftFor(binding: ControlledTaskBinding) {
  const draft = findTaskDraft(binding.taskId, readActiveIdentity() ?? '');
  if (draft.contractHash !== binding.contractHash) throw new TaskDraftError('contract_conflict', 409);
  return draft;
}
function executionFor(binding: ControlledTaskBinding): TaskExecutionRecord {
  const record = readTaskExecution(draftFor(binding));
  if (!record || canonical(taskBinding(record)) !== canonical(taskBinding(binding))) throw new TaskDraftError('execution_uncertain', 409);
  return record;
}
function requirePins(record: TaskExecutionRecord, request: Pick<OwnedLaunchRequest, 'cwd' | 'executionPolicy' | 'model' | 'effort' | 'clientMutationId' | 'runtimeConfig'>, runtime: string) {
  if (record.runtime !== runtime || record.workspacePath !== request.cwd || request.executionPolicy !== 'single-attempt'
    || record.model !== request.model || (record.effort === 'provider-default' ? undefined : record.effort) !== request.effort || request.clientMutationId !== record.attemptId
    || request.runtimeConfig?.workMode !== 'read-only'
    || (record.provider && canonical(request.runtimeConfig) !== canonical({ workMode: 'read-only', ...controlledProviderConfig(record.provider) }))
    || (!record.provider && request.runtimeConfig?.controlledProvider !== undefined)) throw new TaskDraftError('execution_binding_changed', 409);
}

/** Claim the one session before its directory or native identity configuration is created. */
export async function bindControlledTaskSession(request: OwnedLaunchRequest, runtime: string, surfaceId: string): Promise<void> {
  if (!request.controlledTask) return;
  const draft = draftFor(request.controlledTask);
  const admission = launchAccount(executionFor(request.controlledTask));
  await withTaskDraftAccountAdmission(admission, draft.account, () => withTaskExecutionLock(draft.taskId, async () => {
    const record = executionFor(request.controlledTask!);
    requirePins(record, request, runtime);
    if (record.state !== 'accepted' || record.surfaceId) throw new TaskDraftError('execution_already_reserved', 409);
    await verifyTaskExecutionWorkspace(draft, record);
    writeTaskExecution({ ...record, surfaceId });
  }));
}

/** Final account/workspace admission encloses journal publication AND actual spawn. */
export async function withControlledTaskSpawn<T extends OwnedRunRecord>(session: OwnedSessionRecord, runtime: string,
  runId: string, action: () => Promise<T>): Promise<T> {
  if (!session.controlledTask) return action();
  const draft = draftFor(session.controlledTask);
  const admission = launchAccount(executionFor(session.controlledTask));
  return withTaskDraftAccountAdmission(admission, draft.account, () => withTaskExecutionLock(draft.taskId, async () => {
    const record = executionFor(session.controlledTask!);
    requirePins(record, { ...session, clientMutationId: session.launchMutationId, executionPolicy: 'single-attempt' }, runtime);
    if (record.state !== 'accepted' || record.surfaceId !== session.surfaceId || record.runId || !record.laneId
      || record.laneId !== session.laneId
      || session.executionPolicy?.runtime !== runtime || session.executionPolicy.model !== record.model
      || session.executionPolicy.effort !== (record.effort === 'provider-default' ? undefined : record.effort)) throw new TaskDraftError('execution_already_reserved', 409);
    await verifyTaskExecutionWorkspace(draft, record);
    const reserved = { ...record, state: 'spawn_reserved' as const, runId };
    writeTaskExecution(reserved);
    try {
      const result = await action();
      if (!attachSession(record.laneId, session.surfaceId, 'system')
        || !setLaneStatus(record.laneId, result.pid > 0 ? 'running' : 'awaiting_input', 'system')) {
        throw new TaskDraftError('execution_governance_uncertain', 409);
      }
      writeTaskExecution({ ...reserved, state: result.pid > 0 ? 'running' : 'uncertain' });
      return result;
    } catch (error) {
      writeTaskExecution({ ...reserved, state: 'uncertain', errorCode: 'spawn_outcome_unknown' });
      throw error;
    }
  }));
}

/** Called synchronously immediately before actual process creation, inside the account lease. */
export function assertControlledLaunchGrantCurrent(session: OwnedSessionRecord): void {
  if (!session.controlledTask) return;
  const record = executionFor(session.controlledTask);
  if (record.pluginLaunchGrant && record.pluginLaunchGrant.expiresAt <= Date.now()) {
    throw new TaskDraftError('account_changed_or_unavailable', 403);
  }
}

export function readExecutionSession(record: TaskExecutionRecord): OwnedSessionRecord | null {
  if (!record.surfaceId) return null;
  const root = ownedRoots().find((entry) => record.surfaceId!.startsWith(entry.marker));
  if (!root) throw new TaskDraftError('execution_uncertain', 409);
  try {
    const files = [root.root, archiveRootForOwnedSessionRoot(root.root)]
      .map((path) => join(path, record.surfaceId!.slice(root.marker.length), 'session.json')).filter(existsSync);
    if (files.length !== 1) throw new Error('Missing or ambiguous session evidence');
    const session = JSON.parse(readFileSync(files[0]!, 'utf8')) as OwnedSessionRecord;
    if (session.surfaceId !== record.surfaceId || session.repoPath !== record.workspacePath
      || canonical(session.controlledTask) !== canonical(taskBinding(record))
      || session.launchMutationId !== record.attemptId || session.model !== record.model || session.effort !== (record.effort === 'provider-default' ? undefined : record.effort)
      || session.executionPolicy?.mode !== 'single-attempt' || session.executionPolicy.runtime !== record.runtime
      || session.executionPolicy.model !== record.model || session.executionPolicy.effort !== (record.effort === 'provider-default' ? undefined : record.effort)
      || session.runIdentityLedger?.totalRuns !== 1 || !session.runIdentityLedger.complete
      || session.recentRuns.length !== 1 || session.recentRuns[0]?.id !== record.runId) throw new Error('Invalid session');
    requirePins(record, { ...session, clientMutationId: session.launchMutationId, executionPolicy: 'single-attempt' }, record.runtime);
    return session;
  } catch { throw new TaskDraftError('execution_uncertain', 409); }
}

/** Terminal text/exit alone is insufficient: retain uncertainty until group and marker are clear. */
export async function executionRunIsClear(run: OwnedRunRecord): Promise<boolean> {
  if (process.platform === 'win32' || run.spawnState !== 'started' || !run.processGroupId || !run.processMarker) return false;
  try { process.kill(-run.processGroupId, 0); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false; }
  return await probeOwnedRunMarker(run.processMarker) === 'clear';
}
export async function reconcileTaskExecution(record: TaskExecutionRecord): Promise<TaskExecutionRecord> {
  if (!record.runId || !record.surfaceId) return record;
  const session = readExecutionSession(record)!;
  const run = session.recentRuns[0]!;
  if (await executionRunIsClear(run)) {
    if (record.stopRequestedAt) return { ...record, state: 'stopped' };
    if (run.childExit?.classification === 'clean-exit' && run.outcome === 'finished') return { ...record, state: 'completed' };
    if (run.outcome !== 'running') return { ...record, state: 'blocked', errorCode: 'worker_failed' };
  }
  return record;
}
