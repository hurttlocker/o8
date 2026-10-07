import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { PluginPrincipal } from '@/lib/auth/plugin-token';
import { codexParseRunLog } from '@/lib/codex/owned-log';
import { parseClaudeOwnedRunLog } from '@/lib/claude-code/owned-log';
import { ownedRoots } from '@/lib/runtimes/shared/owned-session-index';
import { archiveRootForOwnedSessionRoot } from '@/lib/runtimes/shared/owned-session/archive';
import { RUNS_DIR } from '@/lib/runtimes/shared/owned-session/helpers';
import type { OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session/types';
import { pluginResultText } from './plugin-result';
import { withTaskDraftAccountAdmission } from './task-draft-account';
import { canonical, exactKeys, normalizedText, object, TaskDraftError } from './task-draft-contract';
import { findTaskDraft, type TaskDraftRecord } from './task-draft-store';
import { executionRunIsClear } from './task-execution-admission';
import { readTaskExecution, taskBinding, type TaskExecutionRecord } from './task-execution-store';

function unavailable(): never { throw new TaskDraftError('execution_uncertain', 409); }

/** Never follow persisted arbitrary paths or consume an unbounded/growing file. */
function boundedRead(path: string, max: number): string {
  const before = lstatSync(path);
  if (!before.isFile() || before.nlink !== 1 || before.size > max || realpathSync(path) !== path) unavailable();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev || opened.size > max) unavailable();
    const buffer = Buffer.alloc(max + 1);
    let size = 0;
    while (size <= max) {
      const count = readSync(fd, buffer, size, buffer.length - size, null);
      if (!count) return buffer.subarray(0, size).toString('utf8');
      size += count;
    }
    return unavailable();
  } finally { closeSync(fd); }
}

function boundSession(record: TaskExecutionRecord) {
  const root = ownedRoots().find((entry) => entry.marker === `${record.runtime}-owned:`);
  const suffix = record.surfaceId?.slice(root?.marker.length);
  if (!root || !record.surfaceId?.startsWith(root.marker) || !suffix || !/^[A-Za-z0-9_-]{1,200}$/.test(suffix)
    || !record.runId || !/^[A-Za-z0-9_-]{1,200}$/.test(record.runId)) unavailable();
  const bases = [root.root, archiveRootForOwnedSessionRoot(root.root)];
  const directories = bases.map((base) => join(base, suffix));
  const present = directories.filter((directory) => existsSync(join(directory, 'session.json')));
  if (present.length !== 1) unavailable();
  const directory = realpathSync(present[0]!);
  if (directory !== join(realpathSync(bases[directories.indexOf(present[0]!)]!), suffix)) unavailable();
  const session = JSON.parse(boundedRead(join(directory, 'session.json'), 262_144)) as OwnedSessionRecord;
  const run = session.recentRuns?.[0];
  if (session.surfaceId !== record.surfaceId || session.sessionDir !== present[0]
    || session.repoPath !== record.workspacePath || session.cwd !== record.workspacePath
    || session.laneId !== record.laneId || canonical(session.controlledTask) !== canonical(taskBinding(record))
    || session.launchMutationId !== record.attemptId || session.model !== record.model || session.effort !== record.effort
    || session.runtimeConfig?.workMode !== 'read-only' || session.executionPolicy?.mode !== 'single-attempt'
    || session.executionPolicy.runtime !== record.runtime || session.executionPolicy.model !== record.model
    || session.executionPolicy.effort !== record.effort || session.runIdentityLedger?.totalRuns !== 1
    || !session.runIdentityLedger.complete || session.recentRuns.length !== 1 || run?.id !== record.runId
    || run.mode !== 'launch' || run.modelFallback || run.spawnState !== 'started'
    || !Number.isSafeInteger(run.pid) || run.pid <= 0 || run.processGroupId !== run.pid || !run.processMarker
    || !directories.some((dir) => run.stdoutPath === join(dir, RUNS_DIR, `${record.runId}.jsonl`))) unavailable();
  const runs = join(directory, RUNS_DIR);
  if (realpathSync(runs) !== runs || !lstatSync(runs).isDirectory()) unavailable();
  return { session, run, log: join(runs, `${record.runId}.jsonl`) };
}

function finalOnly(raw: string, runtime: string): string {
  if (runtime !== 'codex') return raw;
  return raw.split('\n').filter((line) => {
    try {
      const item = JSON.parse(line);
      // Rollout assistant analysis must never become a hosted final report.
      return item.type !== 'response_item' || item.payload?.type !== 'message'
        || item.payload?.role !== 'assistant' || item.payload?.phase === 'final';
    } catch { return false; }
  }).join('\n');
}

async function resultFor(draft: TaskDraftRecord): Promise<Record<string, unknown>> {
  const base = { ok: true, taskId: draft.taskId, runtime: draft.contract.runtime, model: draft.contract.model,
    effort: draft.contract.effort, reviewRequired: true, executionEnabled: false, retryAllowed: false };
  const empty = { available: false, reason: 'unavailable' };
  try {
    const record = readTaskExecution(draft);
    if (!record) return { ...base, state: 'held', completed: false, completion: { ...empty, reason: 'not_launched' } };
    const receipt = { ...base, attemptId: record.attemptId, state: record.state, completed: false, completion: empty };
    if (!record.runId && !record.surfaceId) return receipt;
    const { session, run, log } = boundSession(record);
    if (!await executionRunIsClear(run)) return { ...receipt,
      state: record.state === 'completed' || record.state === 'stopped' ? 'uncertain' : record.state };
    if (record.stopRequestedAt || run.interruptRequestedAt) return { ...receipt, state: 'stopped' };
    if (session.activeRun || run.childExit?.classification !== 'clean-exit' || run.childExit.code !== 0
      || run.outcome !== 'finished') return { ...receipt, state: 'blocked' };
    const finished = Date.parse(run.finishedAt ?? '');
    const started = Date.parse(run.startedAt);
    if (!Number.isFinite(finished) || !Number.isFinite(started) || started < Date.parse(record.createdAt)
      || finished < started || finished > Date.now()) unavailable();
    const raw = finalOnly(boundedRead(log, 4_194_304), record.runtime);
    const parsed = record.runtime === 'codex' ? codexParseRunLog(raw, run) : parseClaudeOwnedRunLog(raw, run);
    if (!parsed.completedTurn || parsed.providerFailure || parsed.outcome !== 'finished') {
      return { ...receipt, state: 'blocked' };
    }
    const answer = [...parsed.entries].reverse().find((entry) => entry.kind === 'message'
      && entry.label === (record.runtime === 'codex' ? 'Assistant' : 'claude-assistant') && !entry.thinking)?.text;
    if (!answer?.trim()) unavailable();
    return { ...receipt, state: 'completed', completed: true,
      completion: { available: true, source: 'worker_report', summary: pluginResultText(answer), completedAt: run.finishedAt } };
  } catch {
    return { ...base, state: 'uncertain', completed: false, completion: empty, errorCode: 'execution_uncertain' };
  }
}

/** Read-only, account-bound evidence. No refresh, reconcile write, dispatch or retry. */
export async function readTaskResult(principal: PluginPrincipal, input: unknown): Promise<Record<string, unknown> & { ok: boolean }> {
  const args = object(input);
  exactKeys(args, ['machineId', 'taskId']);
  normalizedText(args.machineId);
  const taskId = normalizedText(args.taskId);
  return withTaskDraftAccountAdmission(principal, undefined, async (account) => {
    const draft = findTaskDraft(taskId, account.accountId);
    if (draft.contract.machineId !== principal.machineId || draft.snapshot.machineId !== principal.machineId
      || draft.snapshot.clientId !== draft.clientId || draft.snapshot.accountId !== account.accountId
      || draft.snapshot.epoch !== account.epoch || canonical(draft.account) !== canonical(account)) {
      throw new TaskDraftError('task_not_found', 404);
    }
    const result = await resultFor(draft);
    if (principal.expiresAt <= Date.now()) throw new TaskDraftError('account_changed_or_unavailable', 403);
    return result as Record<string, unknown> & { ok: boolean };
  });
}
