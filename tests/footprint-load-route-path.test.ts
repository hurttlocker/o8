// resource-owning: drives the REAL operator route handlers against real
// persisted state in an isolated data dir plus a disposable git repo.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'o8-footprint-load-routes-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;

const loadRepo = mkdtempSync(join(tmpdir(), 'o8-footprint-load-repo-'));
function git(...args: string[]) {
  return execFileSync('git', ['-C', loadRepo, ...args], { encoding: 'utf8' });
}
writeFileSync(join(loadRepo, 'README.md'), '# footprint load fixture\n');
execFileSync('git', ['init', '-q', '-b', 'main', loadRepo], { encoding: 'utf8' });
git('config', 'user.email', 'gate@example.invalid');
git('config', 'user.name', 'footprint gate');
git('add', 'README.md');
git('commit', '-qm', 'fixture');

const createMissionRoute = await import('../src/app/api/orchestrator/create-mission/route');
const statusRoute = await import('../src/app/api/orchestrator/status/route');
const stopPacketRoute = await import('../src/app/api/orchestrator/stop-packet/route');
const { getOrCreateWsToken } = await import('../src/lib/ws-auth');
const { LANE_TERMINAL_STATUSES } = await import('../src/lib/lane/terminal-states');
const { createLane } = await import('../src/lib/lane/registry');
const { ORCHESTRATOR_RUNTIMES } = await import('../src/lib/orchestrator/runtime-capabilities');
const {
  LOAD_RUNTIME_BINARIES,
  LOAD_TERMINAL_LANE_STATUSES,
  createHttpLoadDriver,
} = await import('../scripts/lib/footprint-budget-load.mjs');

const ROUTES: Record<string, (request: NextRequest) => Promise<Response>> = {
  '/api/orchestrator/create-mission': createMissionRoute.POST,
  '/api/orchestrator/stop-packet': stopPacketRoute.POST,
};

const served: Array<{ route: string; body: Record<string, unknown> }> = [];
const operatorToken = getOrCreateWsToken();

// The driver's own fetch, wired straight into the real handlers. Nothing about
// the response envelope is invented by this test.
const routedFetch = (async (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
  const route = String(url).replace('http://127.0.0.1:1/', '/').replace('http://127.0.0.1:1', '');
  if (!init?.method) {
    return statusRoute.GET(new NextRequest(`http://127.0.0.1${route}`, { headers: { Host: '127.0.0.1' } }));
  }
  const handler = ROUTES[route];
  if (!handler) throw new Error(`unrouted request: ${route}`);
  served.push({ route, body: JSON.parse(init.body ?? '{}') });
  return handler(new NextRequest(`http://127.0.0.1${route}`, {
    method: 'POST',
    body: init.body,
    headers: {
      'Content-Type': 'application/json',
      Host: '127.0.0.1',
      Authorization: init.headers?.authorization ?? '',
    },
  }));
}) as unknown as typeof fetch;

function driver() {
  return createHttpLoadDriver({
    apiBase: 'http://127.0.0.1:1',
    token: operatorToken,
    repoPath: loadRepo,
    runtime: 'codex',
    rootPid: process.pid,
    fetchImpl: routedFetch,
    snapshot: () => new Map([[process.pid, { pid: process.pid, ppid: 1, cpuTimeSeconds: 0, command: 'vitest' }]]),
    limits: { maxLaneCount: 4, activationTimeoutMs: 2_000, drainTimeoutMs: 5_000, pollMs: 10 },
  });
}

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(loadRepo, { recursive: true, force: true });
});

describe('load scenario against the real operator routes', () => {
  it('binds its runtime table to the product runtime capability contract', () => {
    for (const [runtimeId, binaryName] of Object.entries(LOAD_RUNTIME_BINARIES)) {
      const capability = ORCHESTRATOR_RUNTIMES[runtimeId as keyof typeof ORCHESTRATOR_RUNTIMES];
      expect(capability, `${runtimeId} is not a registered runtime`).toBeTruthy();
      expect(capability.binaryName, `${runtimeId} binary drifted`).toBe(binaryName);
      expect(capability.dispatchable, `${runtimeId} is not dispatchable`).toBe(true);
    }
    // `codex` is the only runtime whose id happens to equal its executable.
    expect(LOAD_RUNTIME_BINARIES['claude-code']).not.toBe('claude-code');
  });

  it('treats exactly the product lane-terminal set as finished', () => {
    expect([...LOAD_TERMINAL_LANE_STATUSES].sort()).toEqual([...LANE_TERMINAL_STATUSES].sort());
  });

  it('reads zero baseline lanes from the real not_found status response', async () => {
    const response = await statusRoute.GET(new NextRequest('http://127.0.0.1/api/orchestrator/status', {
      headers: { Host: '127.0.0.1' },
    }));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(await driver().captureBaseline()).toMatchObject({ activeLaneCount: 0 });
  });

  it('creates a scoped mission through the real route or surfaces its real refusal', async () => {
    served.length = 0;
    // The baseline comes from the real driver, not a hand-built set: git reports
    // resolved paths, and a hand-written path would diff against itself.
    const baseline = await driver().captureBaseline();
    let scope: { missionId: string | null; packetIds: string[] } | null = null;
    let refusal: string | null = null;
    try {
      scope = await driver().createScopedLanes(2);
    } catch (error) {
      refusal = String((error as Error).message);
    }

    expect(served[0].route).toBe('/api/orchestrator/create-mission');
    expect((served[0].body as { issues: unknown[] }).issues).toHaveLength(2);

    if (refusal) {
      // No worker runtime on this machine: the route's real preflight refuses,
      // and the driver reports that instead of inventing a mission. Logged so a
      // run that skips the teardown half says so out loud.
      console.log(`[footprint-load-route-path] creation refused by the real route: ${refusal}`);
      expect(refusal).toMatch(/create-mission failed: \w+/);
      expect(refusal).not.toContain('undefined');
      return;
    }
    console.log('[footprint-load-route-path] creation succeeded; exercising real scoping and teardown');

    expect(scope!.missionId).toBeTruthy();
    expect(scope!.packetIds).toHaveLength(2);

    // Mission creation intentionally does not launch a worker in this test.
    // Bind idle real lane rows so the real stop route has packet-scoped state
    // to archive and its background cleanup can be observed before close.
    for (const [index, packetId] of scope!.packetIds.entries()) {
      createLane({
        repoPath: loadRepo,
        branch: `footprint-load-route-${index + 1}`,
        baseBranch: 'main',
        runtime: 'codex',
        packetId,
        ownership: 'managed',
      });
    }

    // Scoping: the real status route now reports our packets, and the driver
    // counts only those.
    const statusResponse = await statusRoute.GET(new NextRequest('http://127.0.0.1/api/orchestrator/status', {
      headers: { Host: '127.0.0.1' },
    }));
    const status = await statusResponse.json();
    expect(status.ok).toBe(true);
    expect(status.result.missionId).toBe(scope!.missionId);
    expect(status.result.packets.map((packet: { id: string }) => packet.id).sort())
      .toEqual([...scope!.packetIds].sort());

    // Teardown: one bounded stop per created packet, by id, never all:true.
    served.length = 0;
    const dispositions = await driver().releaseScopedLanes(scope!);
    expect(served.map((entry) => entry.route)).toEqual([
      '/api/orchestrator/stop-packet',
      '/api/orchestrator/stop-packet',
    ]);
    for (const entry of served) {
      expect(entry.body.all).toBeUndefined();
      expect(scope!.packetIds).toContain(entry.body.packetId);
    }
    // Every created packet must actually settle after stop. A returned 200 is
    // not enough because stop completes archive/prune in the background.
    expect(dispositions).toHaveLength(scope!.packetIds.length);
    expect(dispositions.map((entry) => entry.outcome)).toEqual(scope!.packetIds.map(() => 'stopped'));
    for (const disposition of dispositions) {
      expect(scope!.packetIds).toContain(disposition.packetId);
      expect(disposition.stage).toBe('stop');
    }

    // Residuals: no worktree was created by an undispatched mission, and the
    // sweep reports through digests only.
    const residuals = await driver().collectResiduals(baseline, scope!);
    expect(residuals.counts.worktrees).toBe(0);
    expect(residuals.counts.lanes).toBe(0);
    expect(residuals.preservedWorktrees).toEqual([]);
    expect(JSON.stringify(residuals)).not.toContain(loadRepo);
  });

  it('keeps the real idempotent stop behavior scoped to the named packet', async () => {
    served.length = 0;
    const dispositions = await driver().releaseScopedLanes({ missionId: 'nope', packetIds: ['packet-that-does-not-exist'] });
    expect(dispositions).toEqual([{
      packetId: 'packet-that-does-not-exist',
      stage: 'stop',
      outcome: 'stopped',
    }]);
    expect(served).toHaveLength(1);
    expect(served[0].body.packetId).toBe('packet-that-does-not-exist');
    expect(served.every((entry) => entry.body.all === undefined)).toBe(true);
  });
});
