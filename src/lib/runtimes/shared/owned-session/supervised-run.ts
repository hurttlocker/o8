import { constants } from 'node:os';
import { ownedSupervisorClient, SupervisorError, type SupervisorAttachment } from '@/lib/runtime/o8d-supervisor';
import { childExitOutcome, readAbnormalStderrTail } from './exit-outcome';
import type { OwnedRunRecord, OwnedSessionRecord } from './types';

export async function attachSupervisedRun(run: Pick<OwnedRunRecord, 'id' | 'pid' | 'processIdentity' | 'supervisor'>, owner: string): Promise<SupervisorAttachment> {
  const reference = run.supervisor;
  if (!reference || reference.id !== run.id || reference.owner !== owner) throw new SupervisorError('ownership-mismatch');
  const state = await ownedSupervisorClient().attach(reference);
  if (state.pid !== run.pid || JSON.stringify(state.identity) !== JSON.stringify(run.processIdentity)) throw new SupervisorError('ownership-mismatch');
  return state;
}

/** Caller saves cursor and terminal effect together under the session lock. */
export async function reconcileSupervisedSession(session: OwnedSessionRecord): Promise<boolean> {
  let dirty = false;
  for (const run of session.recentRuns) {
    if (!run.supervisor || run.finishedAt) continue;
    let state: SupervisorAttachment;
    if (run.spawnState === 'prepared') {
      const reference = run.supervisor;
      if (reference.id !== run.id || reference.owner !== session.surfaceId) throw new SupervisorError('ownership-mismatch');
      state = await ownedSupervisorClient().inspect(run.id, session.surfaceId);
      if (state.state === 'lost' || state.pid <= 0 || !state.identity) throw new SupervisorError('ownership-unverifiable');
      run.pid = state.pid;
      run.processGroupId = state.pid;
      run.processIdentity = state.identity;
      run.processIdentitySource = 'platform';
      run.processIdentityRequired = true;
      run.detachMode = 'detached';
      run.spawnState = 'started';
      run.supervisor.epoch = state.epoch;
      dirty = true;
    } else state = await attachSupervisedRun(run, session.surfaceId);
    for (const event of state.events) {
      if (event.stream !== 'exit' || run.childExit) continue;
      const signal = event.signal === null ? null : Object.entries(constants.signals).find(([, number]) => number === event.signal)?.[0] as NodeJS.Signals | undefined;
      if (signal === undefined) throw new SupervisorError('invalid-exit');
      const outcome = childExitOutcome(event.code, signal);
      const stderrTail = await readAbnormalStderrTail(run.stderrPath, outcome);
      run.childExit = { ...outcome, ...(stderrTail ? { stderrTail } : {}) };
      run.finishedAt = new Date().toISOString();
      run.outcome = run.interruptRequestedAt ? 'interrupted' : event.code === 0 ? 'finished' : 'failed';
      if (session.activeRun?.id === run.id) session.activeRun = undefined;
      dirty = true;
    }
    if (state.cursor !== run.supervisor.cursor) { run.supervisor.cursor = state.cursor; dirty = true; }
    if (session.activeRun?.id === run.id) session.activeRun = run;
  }
  return dirty;
}
