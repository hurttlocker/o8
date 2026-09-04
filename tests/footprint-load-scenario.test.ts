import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LOAD_RUNTIME_BINARIES,
  LOAD_SCENARIO_LIMITS,
  LOAD_UNAVAILABLE_REASONS,
  createHttpLoadDriver,
  isActiveLaneStatus,
  isLiveOperatorPath,
  parseListeningPorts,
  parseWorktreePaths,
  planLoadScenario,
  resolveLoadScenarioRequest,
  runLoadScenario,
  unwrapOperatorResult,
} from '../scripts/lib/footprint-budget-load.mjs';

const MIB = 1024 * 1024;

function allowingProbes(overrides: Record<string, unknown> = {}) {
  return {
    pathExists: () => true,
    isLiveOperatorPath: () => false,
    binaryAvailable: () => true,
    apiTokenAvailable: () => true,
    ...overrides,
  };
}

function unavailableReason(value: { available: boolean } & Record<string, unknown>) {
  if (value.available) throw new Error('expected an unavailable result');
  return value.reason;
}

function loadedSample(index: number) {
  return {
    schemaVersion: 1,
    budgetVersion: 1,
    version: '0.1.0',
    gitSha: 'abc123',
    mode: 'test',
    scenario: 'loaded-lanes',
    artifactDigest: 'digest-a',
    laneCount: 2,
    recordedAt: `2026-08-27T00:0${index}:00.000Z`,
    metrics: {
      idlePhysicalBytes: (1200 + index * 10) * MIB,
      idleCpuPercent: 8 + index,
      idleProcessChurn: 0,
      appBundleBytes: 200 * MIB,
      components: {},
    },
    verdict: 'PASS' as const,
    checks: [{ metric: 'idlePhysicalBytes', actual: (1200 + index * 10) * MIB, ceiling: 1536 * MIB, pass: true }],
  };
}

const CLEAN_COUNTS = { lanes: 0, childProcesses: 0, worktrees: 0, listeners: 0 };
const CLEAN_RESIDUALS = { counts: CLEAN_COUNTS, preservedWorktrees: [], preservedLanes: [] };
const PLAN = { available: true as const, laneCount: 2, runtime: 'codex', binaryName: 'codex', repoPath: '/tmp/load-repo' };

function fakeDriver(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  return {
    calls,
    captureBaseline: async () => {
      calls.push('captureBaseline');
      return { activeLaneCount: 0, worktrees: new Set<string>(), pids: new Set<number>([100]), ports: new Set<number>([3060]) };
    },
    createScopedLanes: async (laneCount: number) => {
      calls.push(`createScopedLanes:${laneCount}`);
      return { missionId: 'm1', packetIds: ['p1', 'p2'] };
    },
    dispatchScopedLanes: async () => { calls.push('dispatchScopedLanes'); },
    waitForActiveLanes: async () => {
      calls.push('waitForActiveLanes');
      return true;
    },
    releaseScopedLanes: async (scope: { packetIds: string[] }) => {
      calls.push(`releaseScopedLanes:${scope.packetIds.join('+') || 'none'}`);
      return scope.packetIds.map((packetId) => ({
        packetId,
        stage: 'stop' as const,
        outcome: 'stopped' as const,
      }));
    },
    collectResiduals: async () => {
      calls.push('collectResiduals');
      return { counts: { ...CLEAN_COUNTS }, preservedWorktrees: [], preservedLanes: [] };
    },
    ...overrides,
  };
}

describe('load scenario configuration', () => {
  it('treats an unset lane count as an explicit not-requested reason, never an approximation', () => {
    expect(resolveLoadScenarioRequest({})).toEqual({ laneCount: 0 });
    expect(planLoadScenario({ request: resolveLoadScenarioRequest({}), probes: allowingProbes() }))
      .toEqual({ available: false, reason: LOAD_UNAVAILABLE_REASONS.notRequested });
  });

  it('refuses an out-of-bound or malformed request instead of clamping it', () => {
    expect(() => resolveLoadScenarioRequest({ O8_FOOTPRINT_LOAD_LANES: '2.5' })).toThrow('non-negative integer');
    expect(() => resolveLoadScenarioRequest({ O8_FOOTPRINT_LOAD_LANES: 'many' })).toThrow('non-negative integer');
    expect(() => resolveLoadScenarioRequest({
      O8_FOOTPRINT_LOAD_LANES: String(LOAD_SCENARIO_LIMITS.maxLaneCount + 1),
    })).toThrow(`exceeds the bound of ${LOAD_SCENARIO_LIMITS.maxLaneCount}`);
    expect(() => resolveLoadScenarioRequest({
      O8_FOOTPRINT_LOAD_LANES: '2',
      O8_FOOTPRINT_LOAD_RUNTIME: 'codex; rm -rf /',
    })).toThrow('plain runtime id');
  });

  it('names the exact missing prerequisite for every unavailable load run', () => {
    const request = resolveLoadScenarioRequest({ O8_FOOTPRINT_LOAD_LANES: '2', O8_FOOTPRINT_LOAD_REPO: '/tmp/load-repo' });
    expect(unavailableReason(planLoadScenario({ request: { ...request, repoPath: null }, probes: allowingProbes() })))
      .toBe(LOAD_UNAVAILABLE_REASONS.loadRepoNotConfigured);
    expect(unavailableReason(planLoadScenario({ request, probes: allowingProbes({ pathExists: () => false }) })))
      .toBe(LOAD_UNAVAILABLE_REASONS.loadRepoMissing);
    expect(unavailableReason(planLoadScenario({ request, probes: allowingProbes({ isLiveOperatorPath: () => true }) })))
      .toBe(LOAD_UNAVAILABLE_REASONS.loadRepoNotIsolated);
    expect(unavailableReason(planLoadScenario({ request, probes: allowingProbes({ binaryAvailable: () => false }) })))
      .toBe(LOAD_UNAVAILABLE_REASONS.workerRuntimeUnavailable);
    expect(unavailableReason(planLoadScenario({ request, probes: allowingProbes({ apiTokenAvailable: () => false }) })))
      .toBe(LOAD_UNAVAILABLE_REASONS.apiTokenUnavailable);
    expect(planLoadScenario({ request, probes: allowingProbes() })).toEqual(PLAN);
  });

  it('resolves the worker executable from the runtime id instead of assuming they match', () => {
    const request = { laneCount: 2, repoPath: '/tmp/load-repo', runtime: 'claude-code' };
    const probed: string[] = [];
    const plan = planLoadScenario({
      request,
      probes: allowingProbes({ binaryAvailable: (binaryName: string) => { probed.push(binaryName); return true; } }),
    });
    expect(probed).toEqual(['claude']);
    expect(plan).toMatchObject({ available: true, runtime: 'claude-code', binaryName: 'claude' });

    const unsupported = planLoadScenario({
      request: { ...request, runtime: 'aider' },
      probes: allowingProbes(),
    });
    expect(unavailableReason(unsupported)).toBe(LOAD_UNAVAILABLE_REASONS.runtimeNotSupported);
    if (unsupported.available) throw new Error('expected an unsupported runtime to be refused');
    expect(unsupported.detail).toEqual({ supported: Object.keys(LOAD_RUNTIME_BINARIES) });
  });

  it('never accepts the live operator profile as the load repo', () => {
    expect(isLiveOperatorPath('/Users/operator/.o8', '/Users/operator')).toBe(true);
    expect(isLiveOperatorPath('/Users/operator/.o8/worktrees/x', '/Users/operator')).toBe(true);
    expect(isLiveOperatorPath('/tmp/load-repo', '/Users/operator')).toBe(false);
    expect(isLiveOperatorPath('/Users/operator/.o8-other', '/Users/operator')).toBe(false);
  });
});

describe('operator response envelope', () => {
  it('reads the result envelope the operator routes actually serve', () => {
    expect(unwrapOperatorResult({ ok: true, result: { missionId: 'm1' } }, '/x')).toEqual({ missionId: 'm1' });
    // A bare top-level field is what the app never serves; treating it as valid
    // would make every downstream read silently undefined.
    expect(() => unwrapOperatorResult({ missionId: 'm1' }, '/x')).toThrow('/x failed: unknown_error');
    expect(() => unwrapOperatorResult({ ok: false, error: { code: 'not_found' } }, '/x')).toThrow('/x failed: not_found');
  });

  it('counts a lane as load until it reaches a lane-terminal status', () => {
    expect(isActiveLaneStatus('running')).toBe(true);
    expect(isActiveLaneStatus('reviewing')).toBe(true);
    expect(isActiveLaneStatus('completed')).toBe(false);
    expect(isActiveLaneStatus('failed')).toBe(false);
    expect(isActiveLaneStatus('archived')).toBe(false);
    expect(isActiveLaneStatus(undefined)).toBe(false);
  });
});

describe('load scenario execution', () => {
  it('does no work and takes no samples when the plan is unavailable', async () => {
    const driver = fakeDriver();
    let sampled = false;
    const result = await runLoadScenario({
      plan: { available: false, reason: LOAD_UNAVAILABLE_REASONS.notRequested },
      driver,
      sample: async () => { sampled = true; return []; },
    });
    expect(result).toEqual({ available: false, reason: LOAD_UNAVAILABLE_REASONS.notRequested });
    expect(driver.calls).toEqual([]);
    expect(sampled).toBe(false);
  });

  it('measures N real lanes and releases exactly the packets it created', async () => {
    const driver = fakeDriver();
    const result = await runLoadScenario({
      plan: PLAN,
      driver,
      sample: async ({ laneCount }) => {
        expect(laneCount).toBe(2);
        return [loadedSample(0), loadedSample(1)];
      },
    });

    if (!result.available) throw new Error(`expected a measured load run, got ${result.reason}`);
    expect(result).toMatchObject({
      laneCount: 2,
      sampleCount: 2,
      teardown: { packetCount: 2, stopped: 2, refused: 0, residuals: CLEAN_RESIDUALS },
    });
    expect(result.aggregate.metrics.idlePhysicalBytes)
      .toEqual({ min: 1200 * MIB, max: 1210 * MIB, mean: 1205 * MIB, median: 1205 * MIB });
    expect(driver.calls).toEqual([
      'captureBaseline',
      'createScopedLanes:2',
      'dispatchScopedLanes',
      'waitForActiveLanes',
      'releaseScopedLanes:p1+p2',
      'collectResiduals',
    ]);
  });

  it('refuses to measure on top of pre-existing lanes', async () => {
    const driver = fakeDriver({
      captureBaseline: async () => ({ activeLaneCount: 1, worktrees: new Set(), pids: new Set(), ports: new Set() }),
    });
    const result = await runLoadScenario({
      plan: PLAN,
      driver,
      sample: async () => { throw new Error('must not sample'); },
    });
    expect(result).toEqual({
      available: false,
      reason: LOAD_UNAVAILABLE_REASONS.preExistingLanes,
      detail: { activeLaneCount: 1 },
    });
  });

  it('reports lanes that never started as unavailable and still releases them', async () => {
    const driver = fakeDriver({ waitForActiveLanes: async () => false });
    const result = await runLoadScenario({
      plan: PLAN,
      driver,
      sample: async () => { throw new Error('must not sample'); },
    });
    expect(result).toMatchObject({
      available: false,
      reason: LOAD_UNAVAILABLE_REASONS.lanesDidNotReachActive,
      laneCount: 2,
      teardown: { packetCount: 2, residuals: CLEAN_RESIDUALS },
    });
    expect(driver.calls).toContain('releaseScopedLanes:p1+p2');
  });

  it('preserves and reports surviving state instead of passing or force-deleting it', async () => {
    const residualKeys = ['lanes', 'childProcesses', 'worktrees', 'listeners'] as const;
    for (const residual of residualKeys) {
      const driver = fakeDriver({
        collectResiduals: async () => ({
          counts: { ...CLEAN_COUNTS, [residual]: 1 },
          preservedWorktrees: residual === 'worktrees' ? [{ digest: 'aaaaaaaaaaaa', insideLoadRepo: true }] : [],
          preservedLanes: residual === 'lanes' ? [{ packetDigest: 'bbbbbbbbbbbb', status: 'running' }] : [],
        }),
      });
      const result = await runLoadScenario({
        plan: PLAN,
        driver,
        sample: async () => [loadedSample(0)],
      });
      if (result.available) throw new Error('expected preserved residual state to refuse the run');
      expect(result.reason).toBe(LOAD_UNAVAILABLE_REASONS.residualStatePreserved);
      expect(result.teardown?.residuals.counts[residual]).toBe(1);
      // The identity is a digest, never a path or a packet id.
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('/tmp/load-repo');
      expect(serialized).not.toContain('"p1"');
    }
  });

  it('releases the created packets even when dispatch itself throws', async () => {
    const base = fakeDriver();
    const driver = {
      ...base,
      dispatchScopedLanes: async () => {
        base.calls.push('dispatchScopedLanes');
        throw new Error('dispatch exploded');
      },
    };
    await expect(runLoadScenario({
      plan: PLAN,
      driver,
      sample: async () => [loadedSample(0)],
    })).rejects.toThrow('dispatch exploded');
    // Scope was captured before dispatch, so teardown still knows both packets.
    expect(base.calls).toEqual([
      'captureBaseline',
      'createScopedLanes:2',
      'dispatchScopedLanes',
      'releaseScopedLanes:p1+p2',
      'collectResiduals',
    ]);
  });
});

describe('load scenario driver', () => {
  const worktreeOutput = [
    'worktree /tmp/load-repo',
    'HEAD abc',
    '',
    'worktree /tmp/load-repo-wt/lane-1',
    'HEAD def',
    '',
  ].join('\n');

  function driverFixture(handlers: {
    post: (route: string, body: Record<string, unknown>) => unknown;
    agents: () => Array<Record<string, unknown>> | null;
    run?: (command: string, args: string[]) => string;
  }) {
    const requests: Array<{ route: string; body: Record<string, unknown> }> = [];
    const fetchImpl = (async (url: string, init?: { method?: string; body?: string }) => {
      const route = String(url).replace('http://127.0.0.1:3060', '');
      if (!init?.method) {
        const agents = handlers.agents();
        if (agents === null) return { ok: false, status: 404, json: async () => ({ ok: false, error: { code: 'not_found' } }) };
        return { ok: true, status: 200, json: async () => ({ ok: true, result: { agents } }) };
      }
      const body = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
      requests.push({ route, body });
      return { ok: true, status: 200, json: async () => ({ ok: true, result: handlers.post(route, body) }) };
    }) as unknown as typeof fetch;

    const driver = createHttpLoadDriver({
      apiBase: 'http://127.0.0.1:3060',
      token: 'gate-token',
      repoPath: '/tmp/load-repo',
      runtime: 'codex',
      rootPid: 100,
      fetchImpl,
      run: handlers.run ?? ((_command: string, args: string[]) => {
        if (args[3] === 'list') return worktreeOutput;
        if (args.includes('-iTCP')) return 'node 100 op 21u TCP 127.0.0.1:3060 (LISTEN)\n';
        return '';
      }),
      snapshot: () => new Map([[100, { pid: 100, ppid: 1, cpuTimeSeconds: 0, command: '/bundle/o8' }]]),
      limits: { ...LOAD_SCENARIO_LIMITS, activationTimeoutMs: 1_000, drainTimeoutMs: 1_000, pollMs: 1 },
    });
    return { driver, requests };
  }

  it('parses worktree and listener probes without carrying commands forward', () => {
    expect(parseWorktreePaths(worktreeOutput)).toEqual(['/tmp/load-repo', '/tmp/load-repo-wt/lane-1']);
    expect([...parseListeningPorts('node 42 op 21u IPv4 TCP 127.0.0.1:3060 (LISTEN)\nnode 43 op 22u TCP *:47105 (LISTEN)\n')])
      .toEqual([3060, 47105]);
    expect([...parseListeningPorts('node 42 op 21u TCP 127.0.0.1:3060 (ESTABLISHED)')]).toEqual([]);
  });

  it('creates one mission carrying N lanes and reads the ids out of the result envelope', async () => {
    let agents: Array<Record<string, unknown>> | null = null;
    const { driver, requests } = driverFixture({
      agents: () => agents,
      post: (route) => {
        if (route.endsWith('/create-mission')) {
          return { missionId: 'm-1', packets: [{ id: 'pkt-a', title: 'a', wave: 1 }, { id: 'pkt-b', title: 'b', wave: 1 }] };
        }
        if (route.endsWith('/dispatch')) {
          agents = [{ packetId: 'pkt-a', status: 'running' }, { packetId: 'pkt-b', status: 'running' }];
          return { dispatched: 2 };
        }
        return { ok: true };
      },
    });

    const scope = await driver.createScopedLanes(2);
    expect(scope).toEqual({ missionId: 'm-1', packetIds: ['pkt-a', 'pkt-b'] });
    await driver.dispatchScopedLanes(scope);
    expect(await driver.waitForActiveLanes(scope)).toBe(true);
    expect(requests[0].route).toBe('/api/orchestrator/create-mission');
    expect((requests[0].body as { issues: unknown[] }).issues).toHaveLength(2);
    expect(JSON.stringify(requests[0].body)).toContain('Do not modify, create, or delete any file');
    expect(requests[1]).toMatchObject({ route: '/api/orchestrator/dispatch', body: { missionId: 'm-1' } });
  });

  it('reports zero baseline lanes when the real status route answers not_found', async () => {
    const { driver } = driverFixture({ agents: () => null, post: () => ({}) });
    expect(await driver.captureBaseline()).toMatchObject({ activeLaneCount: 0 });
  });

  it('ignores lanes it did not create, in the baseline and in the residual sweep', async () => {
    const foreign = [{ packetId: 'someone-else', status: 'running' }];
    const { driver } = driverFixture({ agents: () => foreign, post: () => ({}) });
    const baseline = await driver.captureBaseline();
    expect(baseline.activeLaneCount).toBe(1);
    const residuals = await driver.collectResiduals(baseline, { missionId: 'm-1', packetIds: ['pkt-a'] });
    expect(residuals.counts.lanes).toBe(0);
    expect(residuals.preservedLanes).toEqual([]);
  });

  it('stops each created packet by id, never every lane at once', async () => {
    const { driver, requests } = driverFixture({
      agents: () => [],
      post: () => ({ stopped: true }),
    });

    const dispositions = await driver.releaseScopedLanes({ missionId: 'm-1', packetIds: ['pkt-a', 'pkt-b'] });
    expect(requests.map((request) => request.route)).toEqual([
      '/api/orchestrator/stop-packet',
      '/api/orchestrator/stop-packet',
    ]);
    expect(requests.map((request) => request.body.packetId)).toEqual(['pkt-a', 'pkt-b']);
    for (const request of requests) expect(request.body.all).toBeUndefined();
    expect(dispositions).toEqual([
      { packetId: 'pkt-a', stage: 'stop', outcome: 'stopped' },
      { packetId: 'pkt-b', stage: 'stop', outcome: 'stopped' },
    ]);
  });

  it('records a refused stop instead of deleting the worktree behind the control plane', async () => {
    const commands: string[][] = [];
    const refusing = createHttpLoadDriver({
      apiBase: 'http://127.0.0.1:3060',
      token: 't',
      repoPath: '/tmp/load-repo',
      runtime: 'codex',
      rootPid: 100,
      fetchImpl: (async (url: string, init?: { method?: string }) => {
        if (!init?.method) return { ok: true, status: 200, json: async () => ({ ok: true, result: { agents: [] } }) };
        return { ok: false, status: 409, json: async () => ({ ok: false, error: { code: 'kill_unconfirmed' } }) };
      }) as unknown as typeof fetch,
      run: (command: string, args: string[]) => {
        commands.push([command, ...args]);
        return args[3] === 'list' ? worktreeOutput : '';
      },
      snapshot: () => new Map([[100, { pid: 100, ppid: 1, cpuTimeSeconds: 0, command: '/bundle/o8' }]]),
      limits: { ...LOAD_SCENARIO_LIMITS, drainTimeoutMs: 1, pollMs: 1 },
    });

    const dispositions = await refusing.releaseScopedLanes({ missionId: 'm-1', packetIds: ['pkt-a'] });
    expect(dispositions).toEqual([
      { packetId: 'pkt-a', stage: 'stop', outcome: 'refused', message: expect.stringContaining('kill_unconfirmed') },
    ]);
    // No destructive command was issued anywhere in the refusal path.
    expect(commands.flat()).not.toContain('remove');
    expect(commands.flat()).not.toContain('prune');
  });

  it('reports a surviving worktree as a preserved residual identity, not a deletion', async () => {
    const survivor = mkdtempSync(join(tmpdir(), 'o8-footprint-survivor-'));
    try {
      let worktrees = 'worktree /tmp/load-repo\nHEAD abc\n';
      const commands: string[][] = [];
      const { driver } = driverFixture({
        agents: () => [],
        post: () => ({}),
        run: (command: string, args: string[]) => {
          commands.push([command, ...args]);
          return args[3] === 'list' ? worktrees : '';
        },
      });
      const baseline = await driver.captureBaseline();
      worktrees = `worktree /tmp/load-repo\nHEAD abc\nworktree ${survivor}\nHEAD def\n`;

      const residuals = await driver.collectResiduals(baseline, { missionId: 'm-1', packetIds: [] });

      expect(residuals.counts.worktrees).toBe(1);
      expect(residuals.preservedWorktrees).toEqual([
        { digest: expect.stringMatching(/^[0-9a-f]{12}$/), insideLoadRepo: false },
      ]);
      expect(JSON.stringify(residuals)).not.toContain(survivor);
      expect(commands.flat()).not.toContain('remove');
      expect(existsSync(survivor)).toBe(true);
    } finally {
      rmSync(survivor, { recursive: true, force: true });
    }
  });
});
