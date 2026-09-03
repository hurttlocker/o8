import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  killManagedRun,
  listManagedRuns,
  registerManagedRun,
} from '@/lib/runtimes/managed-runs/registry';
import type { ManagedRunTerminationReceipt } from '@/lib/runtimes/managed-runs/types';

describe('managed-run durable termination receipt', () => {
  it('retains an unknown-signal receipt after a detached wrapper disappears', async () => {
    const id = `missing${Date.now()}`;
    const session = `cortex-run-${id}`;
    registerManagedRun({
      id,
      session,
      command: 'node detached-build.mjs',
      cwd: process.cwd(),
      mode: 'detach',
      startedAt: new Date().toISOString(),
      status: 'running',
    });

    const reconciled = (await listManagedRuns()).find((run) => run.id === id);
    expect(reconciled).toMatchObject({ status: 'gone', exitCode: null });
    expect(readFileSync(
      join(process.env.CORTEX_IDE_DATA_DIR!, 'logs', 'run', `${id}.exit`),
      'utf8',
    )).toBe('signal:UNKNOWN');
  });

  it('persists exit 130 only with confirmed process-tree settlement evidence', () => {
    const id = `receipt${Date.now()}`;
    const session = `cortex-run-${id}`;
    registerManagedRun({
      id,
      session,
      command: 'node long-build.mjs',
      cwd: process.cwd(),
      processGroupId: 123,
      processMarker: `marker-${id}`,
      mode: 'stream',
      startedAt: new Date().toISOString(),
      status: 'running',
    });
    const termination: ManagedRunTerminationReceipt = {
      schema: 'o8/managed-run-termination/v1',
      reason: 'stream_sigint',
      exitCode: 130,
      requestedAt: new Date().toISOString(),
      confirmedAt: new Date().toISOString(),
      confirmedDead: true,
      alreadyDead: false,
      steps: [{
        signal: 'SIGINT',
        groupSignaled: true,
        signaledPids: [123, 124],
        sessionAliveAfter: false,
        markerPidsAfter: [],
        errors: [],
      }],
    };

    const settled = killManagedRun(session, 130, termination);
    expect(settled).toMatchObject({ status: 'killed', exitCode: 130, termination });
    const persisted = JSON.parse(readFileSync(
      join(process.env.CORTEX_IDE_DATA_DIR!, 'managed-runs.json'),
      'utf8',
    )) as { runs: Array<{ session: string; exitCode: number; termination: ManagedRunTerminationReceipt }> };
    expect(persisted.runs.find((entry) => entry.session === session)).toMatchObject({
      exitCode: 130,
      termination: { confirmedDead: true },
    });
  });
});
