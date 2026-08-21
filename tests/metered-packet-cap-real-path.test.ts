import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/runtimes/shared/dispatch-readiness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runtimes/shared/dispatch-readiness')>();
  return {
    ...actual,
    ensureDispatchBackendReady: vi.fn(async () => ({ ready: true, reason: 'test', waitedMs: 0, attempts: 1 })),
  };
});

vi.mock('@/lib/worktree/safety-hooks', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/worktree/safety-hooks')>(),
  writeManagedWorkspaceSafetyHooks: vi.fn(async () => undefined),
}));

vi.mock('@/lib/worktree/storage-telemetry', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/worktree/storage-telemetry')>(),
  measureHostVolume: vi.fn(async () => ({
    accountingStatus: 'observed' as const,
    probePath: '/',
    availableBytes: 90_000_000_000,
    freeBytes: 90_000_000_000,
    totalBytes: 100_000_000_000,
    error: null,
  })),
}));

const root = mkdtempSync(path.join(os.tmpdir(), 'o8-metered-cap-'));
const dataDir = path.join(root, 'data');
const repoPath = path.join(dataDir, 'repo');
const ownedRoot = path.join(dataDir, 'owned');
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT = ownedRoot;
process.env.OPENROUTER_API_KEY = 'test-metered-key';
process.env.O8_CRASH_SURVIVABLE_WORKERS = '1';

mkdirSync(dataDir, { recursive: true });
execFileSync('git', ['init', '-q', '-b', 'main', repoPath]);
writeFileSync(path.join(repoPath, 'README.md'), 'metered test\n');
execFileSync('git', ['-C', repoPath, 'add', 'README.md']);
execFileSync('git', ['-C', repoPath, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'init']);

const fakeWorker = path.join(root, 'fake-worker.mjs');
writeFileSync(fakeWorker, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', async () => {
  await new Promise((resolve) => setTimeout(resolve, 500));
  await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
    body: JSON.stringify({ model: 'metered/test', messages: [{ role: 'user', content: 'test' }] }),
  });
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', session_id: 'fake-metered', total_cost_usd: 6.5, usage: { input_tokens: 653000, output_tokens: 10 } }) + '\\n');
  setInterval(() => {}, 1000);
});
`);
chmodSync(fakeWorker, 0o755);
process.env.O8_CLAUDE_CODE_BIN = fakeWorker;

const upstream = createServer((request, response) => {
  if (request.url !== '/api/v1/messages') {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
    id: 'gen-metered-1',
    content: [{ type: 'text', text: 'ok' }],
    usage: { input_tokens: 653_000, output_tokens: 10, cost: 0.09 },
  }));
});
await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const address = upstream.address();
if (!address || typeof address === 'string') throw new Error('Fake gateway did not bind.');
process.env.O8_OPENROUTER_CLAUDE_CODE_BASE_URL = `http://127.0.0.1:${address.port}/api`;

const { writeClaudeCodeWorkerProfile } = await import('@/lib/claude-code/worker-profile');
const { dispatch } = await import('@/lib/lane/commands');
const { createLane, getLaneEvents } = await import('@/lib/lane/registry');
const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { getMissionStatus } = await import('@/lib/orchestrator/operator-mission-service');
const { GET: getOperatorStatus } = await import('@/app/api/operator/status/route');
const { addRepo } = await import('@/lib/repos/registry');
const { NextRequest } = await import('next/server');

afterAll(() => {
  upstream.close();
  rmSync(root, { recursive: true, force: true });
});

async function waitForEvent(laneId: string, verb: 'spend_cap_hit' | 'kill_escalated') {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const event = getLaneEvents(laneId, 200).find((candidate) => candidate.verb === verb);
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${verb}.`);
}

describe('metered packet cap real path', () => {
  it('uses gateway cost, interrupts the dispatched worker, and surfaces the cap event', async () => {
    await writeClaudeCodeWorkerProfile({ source: 'openrouter', model: 'metered/test', codexModel: null });
    await addRepo(repoPath);
    const packetId = 'packet-metered-real-path';
    const lane = createLane({
      repoPath,
      branch: 'issue/metered-real-path',
      runtime: 'claude-code',
      packetId,
    });
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-metered-real-path',
      repoPath,
      runtime: 'claude-code',
      packets: [{
        id: packetId,
        referenceLabel: 'P1',
        title: 'Metered real path',
        summary: 'Verify authoritative spend and interruption.',
        workspaceTargetPath: repoPath,
        branchTarget: 'issue/metered-real-path',
        runtime: 'claude-code',
        claudeCodeCarrier: 'openrouter',
        dependencyLabels: [],
        dependencyPacketIds: [],
        queueState: 'queued',
        releaseState: 'pending',
        status: 'launching',
        lane: null,
      }],
    });

    const launch = await dispatch({
      verb: 'launch_session',
      laneId: lane.id,
      prompt: 'Exercise the metered gateway.',
      claudeCodeCarrier: 'openrouter',
      spendCap: { carrier: 'openrouter', costUsd: 0.05, inputTokens: 700_000 },
      actor: 'orchestrator',
    });
    expect(launch.ok, launch.note).toBe(true);
    const event = await waitForEvent(lane.id, 'spend_cap_hit');
    expect(event.payload).toMatchObject({ costUsd: 0.09, costSource: 'gateway', costCapUsd: 0.05 });
    const kill = await waitForEvent(lane.id, 'kill_escalated');
    expect(kill.payload).toMatchObject({ confirmed: true });

    const mission = await getMissionStatus({ includeCost: true });
    if (!('cost' in mission) || !mission.cost) throw new Error('Expected mission cost telemetry.');
    expect(mission.cost.packetCosts[0]).toMatchObject({ totalCostUsd: 0.09, costSource: 'gateway' });
    expect(mission.packets[0]).toMatchObject({
      spendTelemetry: { costUsd: 0.09, costSource: 'gateway', capHit: true },
    });

    const request = new NextRequest('http://localhost/api/operator/status');
    const status = await getOperatorStatus(request);
    const body = await status.json() as { spendCapHits: Array<Record<string, unknown>> };
    expect(body.spendCapHits).toEqual(expect.arrayContaining([
      expect.objectContaining({ packetId, costUsd: 0.09, costSource: 'gateway' }),
    ]));
  }, 30_000);
});
