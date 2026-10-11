import 'server-only';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { listSavedSshMachines, SavedMachineError, type SavedSshMachine } from '@/lib/panel/saved-ssh-machines';
import { readRemoteUsageHistory } from './remote-history';
import type { UsageHistorySummary } from './history-types';

export function usageMachines() {
  return [{ id: 'local', label: hostname(), local: true, enabled: true },
    ...listSavedSshMachines().map(({ id, label, enabled }) => ({ id, label, enabled, local: false }))];
}
export function savedUsageMachine(id: string): SavedSshMachine {
  const machine = listSavedSshMachines().find(machine => machine.id === id);
  if (!machine) throw new SavedMachineError('machine_not_found', 'Choose a saved machine.', 404);
  if (!machine.enabled) throw new SavedMachineError('machine_disabled', 'This machine is disabled.', 409);
  return machine;
}
interface Job { snapshot: UsageHistorySummary | null; pending: boolean; startedAt: number; error: boolean }
const host = globalThis as typeof globalThis & { __o8RemoteUsageHistoryV1?: Map<string, Job> };
const jobs = host.__o8RemoteUsageHistoryV1 ??= new Map();
/** Coalesced per saved connection and date range, independent of local scans and other hosts. */
export function getRemoteUsageHistoryState(machine: SavedSshMachine, input: { days: 1 | 7 | 30 | 90; timeZone: string; fresh?: boolean }) {
  const connection = createHash('sha256').update(JSON.stringify(machine)).digest('hex');
  const key = `${connection}:${input.days}:${input.timeZone}`;
  let job = jobs.get(key);
  if (!job) { job = { snapshot: null, pending: false, startedAt: 0, error: false }; jobs.set(key, job); }
  const elapsed = Date.now() - job.startedAt;
  if (!job.pending && (elapsed > 60_000 || (!job.snapshot && !job.error) || (input.fresh && elapsed > 1_000))) {
    job.pending = true; job.error = false; job.startedAt = Date.now(); const current = job;
    void readRemoteUsageHistory(machine, input).then(snapshot => { current.snapshot = snapshot; })
      .catch(() => { current.error = true; }).finally(() => { current.pending = false; });
  }
  if (jobs.size > 32) for (const [otherKey, other] of jobs) {
    if (otherKey !== key && !other.pending) { jobs.delete(otherKey); break; }
  }
  return job;
}
