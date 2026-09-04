import { recordAutomationSourceEvent } from '@/lib/automations/source-events';
import {
  killManagedRun,
  listManagedRuns,
} from '@/lib/runtimes/managed-runs/registry';
import { terminateManagedRun } from '@/lib/runtimes/managed-runs/termination';
import type {
  ManagedRunRecord,
  ManagedRunTerminationReceipt,
} from '@/lib/runtimes/managed-runs/types';

export interface PacketManagedRunStopFailure {
  id: string;
  session: string;
  reason: 'termination_error' | 'termination_unconfirmed';
}

export interface PacketManagedRunStopReceipt {
  targeted: number;
  confirmed: number;
  failures: PacketManagedRunStopFailure[];
}

interface PacketManagedRunStopDependencies {
  listRuns: () => Promise<ManagedRunRecord[]>;
  terminate: (
    record: ManagedRunRecord,
  ) => Promise<ManagedRunTerminationReceipt>;
  markKilled: (
    session: string,
    termination: ManagedRunTerminationReceipt,
  ) => ManagedRunRecord | null;
  recordKilled: (record: ManagedRunRecord) => void;
}

const defaultDependencies: PacketManagedRunStopDependencies = {
  listRuns: listManagedRuns,
  terminate: (record) => terminateManagedRun(record, {
    reason: 'operator_stop',
    exitCode: null,
  }),
  markKilled: (session, termination) => killManagedRun(session, null, termination),
  recordKilled: (record) => {
    try {
      recordAutomationSourceEvent({
        sourceKind: 'managed_run',
        sourceId: record.id,
        repoPath: record.cwd,
        eventType: 'killed',
        fingerprint: `managed-run:${record.id}:killed:${record.finishedAt ?? 'unknown'}`,
        payload: {
          exitCode: record.exitCode ?? null,
          reason: 'packet_stop',
          status: record.status,
        },
      });
    } catch {
      // Process settlement is authoritative even when optional automation telemetry is unavailable.
    }
  },
};

/**
 * Settle o8-managed commands started from a packet before its worktree is pruned.
 *
 * A worker runtime can launch `o8 run`, whose tmux-owned process tree deliberately
 * outlives the CLI that registered it. Stopping only the worker therefore does not
 * prove the packet is quiescent. Registration binds the managed run to the packet;
 * this function consumes that authority and requires both tmux and marker probes to
 * clear before the packet cleanup path may continue.
 */
export async function terminatePacketManagedRuns(
  packetId: string,
  dependencies: Partial<PacketManagedRunStopDependencies> = {},
): Promise<PacketManagedRunStopReceipt> {
  const deps = { ...defaultDependencies, ...dependencies };
  const targets = (await deps.listRuns()).filter((run) => (
    run.packetId === packetId && (run.status === 'running' || run.status === 'gone')
  ));
  const failures: PacketManagedRunStopFailure[] = [];
  let confirmed = 0;

  for (const target of targets) {
    let termination: ManagedRunTerminationReceipt;
    try {
      termination = await deps.terminate(target);
    } catch {
      failures.push({
        id: target.id,
        session: target.session,
        reason: 'termination_error',
      });
      continue;
    }
    if (!termination.confirmedDead) {
      failures.push({
        id: target.id,
        session: target.session,
        reason: 'termination_unconfirmed',
      });
      continue;
    }
    const settled = deps.markKilled(target.session, termination);
    if (settled) deps.recordKilled(settled);
    confirmed += 1;
  }

  return { targeted: targets.length, confirmed, failures };
}
