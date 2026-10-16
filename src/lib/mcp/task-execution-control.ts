import { revokeControlledGateway } from '@/lib/claude-code/controlled-gateway';
import { revokeReadOnlyWorkerToken } from '@/lib/auth/read-only-worker-token';
import { launchRuntimeSurface } from '@/lib/runtime/actions';
import { escalateInterruptOwnedSurface } from '@/lib/runtime/interrupt-escalation';
import { createLane } from '@/lib/lane/registry';
import { withAccountStateAdmission } from '@/lib/auth/account-state';
import { readActiveIdentity } from '@/lib/github-broker/managed';
import { withTaskDraftAccountAdmission } from './task-draft-account';
import { exactKeys, normalizedText, object, TaskDraftError } from './task-draft-contract';
import { findTaskDraft, type TaskDraftRecord } from './task-draft-store';
import { operatorAccount, readExecutionSession, reconcileTaskExecution } from './task-execution-admission';
import { executionReceipt, readTaskExecution, reserveTaskExecution, taskBinding, withTaskExecutionLock,
  writeTaskExecution, type TaskExecutionRecord } from './task-execution-store';
import { prepareTaskExecutionWorkspace, verifyTaskSource } from './task-execution-workspace';
import { admittedTaskInstructions } from './task-draft-workspace';
import { PLUGIN_LAUNCH_TASK_SCOPE, type PluginPrincipal } from '@/lib/auth/plugin-token';
import { CONTROLLED_OPENROUTER_MODEL, parseControlledProvider } from '@/lib/runtimes/shared/owned-session/controlled-provider';

async function promptFor(draft: TaskDraftRecord): Promise<string> {
  const instructions = await admittedTaskInstructions(draft.snapshot.repoPath, draft.contract.allowedFiles, draft.snapshot.rulesDigest);
  return ['Your working directory is the admitted isolated workspace. Requested files are copies at the same relative paths below. Read them relative to this directory; do not use the original repository path or reopen instruction files.',
    instructions, 'Current task:', draft.contract.objective, 'Read-only task. Report evidence to stdout; never modify files or contact o8 APIs.',
    `Requested file scope: ${draft.contract.allowedFiles.join(', ')}`,
    `Acceptance evidence: ${draft.contract.evidence.join('\n')}`,
    `Sealed task contract: ${JSON.stringify(draft.contract.sealedTaskContract)}`].join('\n\n');
}
async function fail(draft: TaskDraftRecord): Promise<void> {
  await withTaskExecutionLock(draft.taskId, async () => {
    const record = readTaskExecution(draft);
    if (record && !record.stopRequestedAt && !['completed', 'stopped'].includes(record.state)) {
      writeTaskExecution({ ...record, state: record.runId ? 'uncertain' : 'blocked', errorCode: 'launch_held' });
    }
  });
}
async function launch(draft: TaskDraftRecord, record: TaskExecutionRecord): Promise<void> {
  try {
    await prepareTaskExecutionWorkspace(draft, record);
    const prompt = await promptFor(draft);
    const lane = createLane({ repoPath: draft.snapshot.repoPath, projectId: draft.contract.projectId,
      worktreePath: record.workspacePath, runtime: record.runtime, branch: '', baseBranch: draft.snapshot.revision,
      label: `Controlled task ${draft.taskId}`, ownership: 'managed', actor: 'user' });
    await withTaskExecutionLock(draft.taskId, async () => {
      const current = readTaskExecution(draft)!;
      if (current.state !== 'accepted' || current.laneId) throw new TaskDraftError('execution_already_reserved', 409);
      writeTaskExecution({ ...current, laneId: lane.id });
    });
    const result = await launchRuntimeSurface({ runtime: record.runtime, model: record.model, effort: record.effort === 'provider-default' ? undefined : record.effort,
      controlledProvider: record.provider,
      ...(record.runtime === 'claude-code' ? { claudeCodeModel: record.model, claudeCodeCarrier: record.provider ? 'openrouter' : 'native' } : {}),
      executionPolicy: 'single-attempt', controlledTask: taskBinding(record), clientMutationId: record.attemptId,
      cwd: record.workspacePath, repoPath: record.workspacePath, projectRepoPath: draft.snapshot.repoPath,
      existingLaneId: lane.id, isolate: false, skipSetup: true, workMode: 'read-only',
      taskName: `Controlled task ${draft.taskId}`, prompt });
    if (!result.ok) await fail(draft);
  } catch { await fail(draft); }
}

/** Stop is a local safety decision: no current launch entitlement or old sign-in epoch is required. */
async function stop(taskId: string, hash: string) {
  return withAccountStateAdmission(async () => {
    const draft = findTaskDraft(taskId, readActiveIdentity() ?? undefined);
    if (draft.contractHash !== hash) throw new TaskDraftError('contract_conflict', 409);
    const target = await withTaskExecutionLock(taskId, async () => {
      const record = readTaskExecution(draft);
      if (!record) throw new TaskDraftError('execution_unavailable', 409);
      const stopped = { ...record, state: 'stop_requested' as const,
        stopRequestedAt: record.stopRequestedAt ?? new Date().toISOString() };
      writeTaskExecution(stopped); // Publication/sync uncertainty forbids subsequent signals.
      if (stopped.surfaceId) revokeControlledGateway(stopped.surfaceId);
      if (stopped.runId) revokeReadOnlyWorkerToken(stopped.runId);
      if (stopped.runId) readExecutionSession(stopped);
      return stopped;
    });
    if (target.surfaceId && target.runId) await escalateInterruptOwnedSurface(target.surfaceId);
    return withTaskExecutionLock(taskId, async () => {
      const latest = await reconcileTaskExecution(readTaskExecution(draft)!);
      writeTaskExecution(latest);
      return executionReceipt(latest, true);
    });
  });
}

export function controlTaskExecution(input: unknown) {
  return controlTaskExecutionInner(input);
}

async function controlTaskExecutionInner(input: unknown, principal?: PluginPrincipal) {
  const args = object(input);
  exactKeys(args, ['action', 'taskId', 'contractHash']);
  if (!['launch', 'inspect', 'stop'].includes(String(args.action))) throw new TaskDraftError('invalid_action');
  const taskId = normalizedText(args.taskId, 36);
  const hash = normalizedText(args.contractHash, 64);
  if (args.action === 'stop') return stop(taskId, hash);
  let draft!: TaskDraftRecord;
  const admission = principal ?? operatorAccount();
  const admitted = await withTaskDraftAccountAdmission(admission, undefined, async (account) => {
    draft = findTaskDraft(taskId, account.accountId);
    if (principal && (draft.clientId !== principal.clientId || draft.snapshot.clientId !== principal.clientId
      || draft.contract.machineId !== principal.machineId || draft.snapshot.machineId !== principal.machineId)) {
      throw new TaskDraftError('task_unavailable', 404);
    }
    if (hash !== draft.contractHash) throw new TaskDraftError('contract_conflict', 409);
    return withTaskDraftAccountAdmission(admission, draft.account, async () => {
      const previous = readTaskExecution(draft);
      if (args.action === 'launch') {
        if (!previous) await verifyTaskSource(draft);
        return reserveTaskExecution(draft, principal ? { clientId: principal.clientId,
          machineId: principal.machineId, expiresAt: principal.expiresAt } : undefined);
      }
      if (!previous) throw new TaskDraftError('execution_unavailable', 409);
      return { record: previous, created: false };
    });
  });
  if (admitted.created) await launch(draft, admitted.record);
  const latest = await withTaskDraftAccountAdmission(admission, draft.account,
    () => withTaskExecutionLock(taskId, async () => {
      const record = await reconcileTaskExecution(readTaskExecution(draft)!);
      writeTaskExecution(record);
      return record;
    }));
  return executionReceipt(latest, !admitted.created);
}

/** A scoped hosted decision, never an operator credential or arbitrary launch request. */
export async function controlHostedTaskExecution(principal: PluginPrincipal, input: unknown, action: 'launch' | 'stop') {
  if (!principal.scopes.includes(PLUGIN_LAUNCH_TASK_SCOPE)) throw new TaskDraftError('forbidden', 403);
  const args = object(input);
  exactKeys(args, ['machineId', 'taskId', 'contractHash']);
  const taskId = normalizedText(args.taskId, 36);
  const hash = normalizedText(args.contractHash, 64);
  const draft = await withTaskDraftAccountAdmission(principal, undefined, async (account) => {
    const draft = findTaskDraft(taskId, account.accountId);
    if (args.machineId !== principal.machineId || draft.contract.machineId !== principal.machineId
      || draft.snapshot.machineId !== principal.machineId || draft.clientId !== principal.clientId
      || draft.snapshot.clientId !== principal.clientId) throw new TaskDraftError('task_unavailable', 404);
    if (draft.contractHash !== hash) throw new TaskDraftError('contract_conflict', 409);
    if (draft.contract.runtime !== 'claude-code' || draft.contract.model !== CONTROLLED_OPENROUTER_MODEL
      || draft.contract.effort !== 'provider-default' || draft.contract.workMode !== 'read-only') throw new TaskDraftError('forbidden', 403);
    try { parseControlledProvider(draft.contract.provider); }
    catch { throw new TaskDraftError('forbidden', 403); }
    await withTaskDraftAccountAdmission(principal, draft.account, () => undefined);
    return draft;
  });
  // Setup remains outside the lease; reserve/bind/final spawn each re-admit the
  // persisted expiring grant. Do not let the gateway listener inherit a lease.
  const decision = () => controlTaskExecutionInner({ action, taskId, contractHash: hash }, principal);
  const execution = action === 'stop'
    ? await withTaskDraftAccountAdmission(principal, draft.account, decision)
    : await decision();
  return { ok: true, taskId, execution, completed: execution.completed, retryAllowed: false };
}
