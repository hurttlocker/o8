import { describe, expect, it } from 'vitest';

import { registerOwnedSessionLifecycleHandler } from '@/lib/runtimes/shared/owned-session-lifecycle';
import type { OwnedWorkspaceBindingReceipt } from '@/lib/runtimes/shared/owned-session';
import { probeOwnedSessionProcessQuiescence } from './process-probes';

function register(
  prefix: string,
  receipt: OwnedWorkspaceBindingReceipt,
): void {
  registerOwnedSessionLifecycleHandler({
    runtimeId: 'probe-test',
    surfaceIdPrefix: prefix,
    commandLabel: 'probe-test',
    resolveRoot: () => '/tmp/probe-test',
    sessionState: async () => 'active',
    archiveSession: async () => ({ archived: false, note: 'unused' }),
    getWorkspaceBinding: async () => receipt,
    rebindWorkspace: async () => ({ status: 'missing', receipt: null, note: 'unused' }),
  });
}

function binding(surfaceId: string, processGroupId?: number): OwnedWorkspaceBindingReceipt {
  const run = {
    id: `${surfaceId}-run-id`,
    outcome: 'running' as const,
    pid: 4241,
    processGroupId,
    commandIdentity: 'worker',
    processMarker: `${surfaceId}-run`,
  };
  return {
    surfaceId,
    runtimeId: 'probe-test',
    sessionState: 'active',
    binding: {
      logicalWorkspaceId: 'packet:probe',
      repositoryUuid: 'repo-probe',
      packetId: 'packet-probe',
      cwd: '/tmp/probe-workspace',
      version: 1,
      verifiedAt: '2026-08-14T00:00:00.000Z',
    },
    activeRun: {
      pid: run.pid,
      processGroupId: run.processGroupId,
      commandIdentity: run.commandIdentity,
      processMarker: run.processMarker,
    },
    retainedRuns: [run],
    retainedRunsComplete: true,
    retainedRunTotal: 1,
  };
}

describe('owned process probes', () => {
  it('detects orphaned process-group children after the recorded leader exits', async () => {
    const surfaceId = 'probe-orphan:session';
    register('probe-orphan:', binding(surfaceId, 4242));
    const receipt = await probeOwnedSessionProcessQuiescence(surfaceId, '/tmp/probe-workspace', {
      run: async (command, args) => {
        if (command === 'ps') return { code: 1, stdout: '', stderr: '' };
        if (command === 'pgrep' && args[0] === '-g') return { code: 0, stdout: '4999\n', stderr: '' };
        if (command === 'pgrep') return { code: 1, stdout: '', stderr: '' };
        if (command === 'lsof') return { code: 1, stdout: '', stderr: '' };
        throw new Error(`unexpected command: ${command}`);
      },
    });

    expect(receipt.state).toBe('live');
    expect(receipt.probes).toContainEqual(expect.objectContaining({
      primitive: 'process_group',
      state: 'live',
      pids: [4999],
    }));
  });

  it('treats lsof exit one with diagnostic stderr as unknown', async () => {
    const surfaceId = 'probe-lsof:session';
    register('probe-lsof:', {
      ...binding(surfaceId),
      activeRun: null,
      retainedRuns: [],
      retainedRunTotal: 0,
    });
    const receipt = await probeOwnedSessionProcessQuiescence(surfaceId, '/tmp/probe-workspace', {
      run: async (command) => command === 'lsof'
        ? { code: 1, stdout: '', stderr: 'permission denied' }
        : { code: 1, stdout: '', stderr: '' },
    });

    expect(receipt.state).toBe('unknown');
    expect(receipt.probes).toContainEqual(expect.objectContaining({
      primitive: 'filesystem_users',
      state: 'unknown',
    }));
  });

  it('detects a detached child that escaped the recorded PID tree and process group', async () => {
    const surfaceId = 'probe-escaped:session';
    register('probe-escaped:', binding(surfaceId, 4242));
    const receipt = await probeOwnedSessionProcessQuiescence(surfaceId, '/tmp/probe-workspace', {
      run: async (command, args) => {
        if (command === 'ps' && args.includes('-p')) return { code: 1, stdout: '', stderr: '' };
        if (command === 'ps') {
          return {
            code: 0,
            stdout: `9001 escaped-worker O8_OWNED_RUN_MARKER=${surfaceId}-run\n`,
            stderr: '',
          };
        }
        if (command === 'pgrep') return { code: 1, stdout: '', stderr: '' };
        if (command === 'lsof') return { code: 1, stdout: '', stderr: '' };
        throw new Error(`unexpected command: ${command}`);
      },
    });

    expect(receipt.state).toBe('live');
    expect(receipt.probes).toContainEqual(expect.objectContaining({
      primitive: 'owned_marker',
      state: 'live',
      pids: [9001],
    }));
  });

  it('blocks quiescence when an older retained run marker survives a newer completed run', async () => {
    const surfaceId = 'probe-retained:session';
    const receipt = binding(surfaceId);
    receipt.activeRun = null;
    receipt.retainedRuns = [
      {
        id: 'newer-run',
        outcome: 'finished',
        pid: 5252,
        commandIdentity: 'worker',
        processGroupId: 5252,
        processMarker: 'newer-marker',
      },
      {
        id: 'older-run',
        outcome: 'finished',
        pid: 4241,
        commandIdentity: 'worker',
        processGroupId: 4241,
        processMarker: 'older-marker',
      },
    ];
    receipt.retainedRunTotal = 2;
    register('probe-retained:', receipt);

    const result = await probeOwnedSessionProcessQuiescence(surfaceId, '/tmp/probe-workspace', {
      run: async (command, args) => {
        if (command === 'ps' && args.includes('-p')) return { code: 1, stdout: '', stderr: '' };
        if (command === 'ps') {
          return {
            code: 0,
            stdout: '9001 escaped-worker O8_OWNED_RUN_MARKER=older-marker\n',
            stderr: '',
          };
        }
        if (command === 'pgrep') return { code: 1, stdout: '', stderr: '' };
        if (command === 'lsof') return { code: 1, stdout: '', stderr: '' };
        throw new Error(`unexpected command: ${command}`);
      },
    });

    expect(result.state).toBe('live');
    expect(result.identity).toMatchObject({
      pidIdentity: 'not_applicable',
      retainedRuns: [
        { runId: 'newer-run', pidIdentity: 'not_applicable' },
        { runId: 'older-run', pidIdentity: 'not_applicable' },
      ],
    });
    expect(result.probes).toContainEqual(expect.objectContaining({
      primitive: 'owned_marker',
      state: 'live',
      pids: [9001],
    }));
  });

  it('proves quiescence only after every retained run identity is clear', async () => {
    const surfaceId = 'probe-retained-clear:session';
    const receipt = binding(surfaceId);
    receipt.activeRun = null;
    receipt.retainedRuns = [
      {
        id: 'newer-run',
        outcome: 'finished',
        pid: 5252,
        commandIdentity: 'worker',
        processGroupId: 5252,
        processMarker: 'newer-marker',
      },
      {
        id: 'older-run',
        outcome: 'finished',
        pid: 4241,
        commandIdentity: 'worker',
        processGroupId: 4241,
        processMarker: 'older-marker',
      },
    ];
    receipt.retainedRunTotal = 2;
    register('probe-retained-clear:', receipt);

    const result = await probeOwnedSessionProcessQuiescence(surfaceId, '/tmp/probe-workspace', {
      run: async (command, args) => {
        if (command === 'ps' && args.includes('-p')) return { code: 1, stdout: '', stderr: '' };
        if (command === 'ps') return { code: 0, stdout: '', stderr: '' };
        if (command === 'pgrep') return { code: 1, stdout: '', stderr: '' };
        if (command === 'lsof') return { code: 1, stdout: '', stderr: '' };
        throw new Error(`unexpected command: ${command}`);
      },
    });

    expect(result.state).toBe('quiescent');
    expect(result.identity.retainedRuns).toHaveLength(2);
    expect(result.probes).toEqual(expect.arrayContaining([
      expect.objectContaining({ primitive: 'pid', state: 'clear' }),
      expect.objectContaining({ primitive: 'owned_marker', state: 'clear' }),
      expect.objectContaining({ primitive: 'filesystem_users', state: 'clear' }),
    ]));
  });

  it('fails closed when a retained legacy run lacks a durable process marker', async () => {
    const surfaceId = 'probe-legacy-run:session';
    const receipt = binding(surfaceId);
    receipt.activeRun = null;
    receipt.retainedRuns = [{
      id: 'legacy-run',
      outcome: 'finished',
      pid: 4241,
      commandIdentity: 'worker',
      processGroupId: 4241,
    }];
    receipt.retainedRunTotal = 1;
    register('probe-legacy-run:', receipt);

    const result = await probeOwnedSessionProcessQuiescence(surfaceId, '/tmp/probe-workspace', {
      run: async (command) => command === 'lsof'
        ? { code: 1, stdout: '', stderr: '' }
        : { code: 1, stdout: '', stderr: '' },
    });

    expect(result.state).toBe('unknown');
    expect(result.probes).toContainEqual(expect.objectContaining({
      primitive: 'owned_marker',
      state: 'unknown',
    }));
  });

  it('fails closed after run seventeen even when all sixteen retained identities are clear', async () => {
    const surfaceId = 'probe-incomplete-ledger:session';
    const receipt = binding(surfaceId);
    receipt.activeRun = null;
    receipt.retainedRuns = Array.from({ length: 16 }, (_, index) => ({
      id: `retained-${index + 2}`,
      outcome: 'finished' as const,
      pid: 4_002 + index,
      commandIdentity: 'worker',
      processGroupId: 4_002 + index,
      processMarker: `marker-${index + 2}`,
    }));
    receipt.retainedRunsComplete = false;
    receipt.retainedRunTotal = 17;
    register('probe-incomplete-ledger:', receipt);

    const result = await probeOwnedSessionProcessQuiescence(surfaceId, '/tmp/probe-workspace', {
      run: async (command, args) => {
        if (command === 'ps' && args.includes('-p')) return { code: 1, stdout: '', stderr: '' };
        if (command === 'ps') return { code: 0, stdout: '', stderr: '' };
        if (command === 'pgrep') return { code: 1, stdout: '', stderr: '' };
        if (command === 'lsof') return { code: 1, stdout: '', stderr: '' };
        throw new Error(`unexpected command: ${command}`);
      },
    });

    expect(result.state).toBe('unknown');
    expect(result.identity.retainedRuns).toHaveLength(16);
    expect(result.reasons).toContain(
      'retained_run_ledger: The retained-run ledger is legacy, corrupt, or permanently incomplete.',
    );
    expect(result.probes).toContainEqual(expect.objectContaining({ primitive: 'pid', state: 'clear' }));
  });

  it('refuses runtimes without exact owned-workspace binding support', async () => {
    registerOwnedSessionLifecycleHandler({
      runtimeId: 'legacy-owned',
      surfaceIdPrefix: 'probe-legacy:',
      commandLabel: 'legacy',
      resolveRoot: () => '/tmp/legacy',
      sessionState: async () => 'active',
      archiveSession: async () => ({ archived: false, note: 'unused' }),
    });
    const receipt = await probeOwnedSessionProcessQuiescence(
      'probe-legacy:session',
      '/tmp/probe-workspace',
    );
    expect(receipt.state).toBe('unknown');
  });
});
