/**
 * #2195 — drive the persisted headless scheduler, not the refusal guard alone.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const preflight = vi.hoisted(() => ({
  detail: 'The selected runtime has no credential evidence.',
  probeLogPath: '',
}));

vi.mock('@/lib/runtimes/shared/auth-detect', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runtimes/shared/auth-detect')>();
  const { execFileSync: spawnProbe } = await import('node:child_process');
  return {
    ...actual,
    assertRuntimeDispatchable: vi.fn(async (runtime: string) => {
      // Each call launches a real child process, standing in for the auth CLI
      // probe that the production preflight spawned on every scheduler pass.
      spawnProbe(process.execPath, [
        '-e',
        'require("node:fs").appendFileSync(process.env.O8_PROBE_LOG, "probe\\n")',
      ], {
        env: { ...process.env, O8_PROBE_LOG: preflight.probeLogPath },
      });
      throw new actual.DispatchPreflightError({
        house: 'opencode',
        runtime: runtime as never,
        installed: true,
        ready: false,
        authenticated: false,
        unavailableReason: 'needs_auth',
        detail: preflight.detail,
        fix: 'Sign in to the runtime, then reset the packet.',
        checkedAt: Date.now(),
      });
    }),
  };
});

const runtimeLaunch = vi.hoisted(() => vi.fn(async () => {
  throw new Error('preflight must refuse before any launch is attempted');
}));

vi.mock('@/lib/runtime/actions', () => ({
  launchRuntimeSurface: runtimeLaunch,
}));

vi.mock('@/lib/realtime/publisher', () => ({
  publishRealtimeMutation: vi.fn(async () => {}),
}));

const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const {
  readOrchestratorControlPlaneState,
  writeOrchestratorControlPlaneState,
} = await import('@/lib/orchestrator/control-plane');
const { runHeadlessSprintTick } = await import('@/lib/orchestrator/headless-loop');
const { getDispatchBlocker } = await import('@/lib/orchestrator/scheduling');
const { setDispatchPreflightIncidentWriterForTests } =
  await import('@/lib/orchestrator/dispatch-preflight-refusal');
const { findLaneByPacket } = await import('@/lib/lane/registry');
const { enqueueInboxItem, listInboxItems } = await import('@/lib/supervisor/inbox');
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const testRoot = mkdtempSync(join(tmpdir(), 'o8-preflight-refusal-bound-'));
const repoPath = join(testRoot, 'repo');
const probeLogPath = join(testRoot, 'auth-probes.log');

beforeAll(() => {
  mkdirSync(repoPath, { recursive: true });
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repoPath });
  writeFileSync(join(repoPath, 'README.md'), 'preflight refusal bound\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repoPath });
  execFileSync('git', [
    '-c', 'user.email=test@o8.local',
    '-c', 'user.name=o8-test',
    'commit', '-m', 'init',
  ], { cwd: repoPath });
});

beforeEach(() => {
  preflight.probeLogPath = probeLogPath;
  rmSync(probeLogPath, { force: true });
  runtimeLaunch.mockClear();
  let writes = 0;
  setDispatchPreflightIncidentWriterForTests((input) => {
    writes += 1;
    if (writes === 1) throw new Error('injected first incident write failure');
    return enqueueInboxItem(input);
  });
});

afterAll(() => {
  setDispatchPreflightIncidentWriterForTests(null);
  rmSync(testRoot, { recursive: true, force: true });
});

function refusedPacket(): OrchestratorPacket {
  return {
    id: 'pkt-preflight-refused-2195',
    referenceLabel: 'PKT-PREFLIGHT-2195',
    title: 'packet the preflight always refuses',
    summary: 'packet the preflight always refuses',
    workspaceTargetPath: repoPath,
    branchTarget: 'issue/2195-preflight-refusal',
    runtime: 'opencode',
    dispatchRuntimePin: 'opencode',
    dependencyLabels: [],
    dependencyPacketIds: [],
    queueState: 'queued',
    releaseState: 'pending',
    status: 'queued',
    attemptCount: 0,
    maxAttempts: 2,
    blockedReason: null,
    lane: null,
  };
}

function onlyPersisted(): OrchestratorPacket {
  const packet = readOrchestratorControlPlaneState().packets
    .find((candidate) => candidate.id === 'pkt-preflight-refused-2195');
  if (!packet) throw new Error('persisted packet vanished');
  return packet;
}

describe('#2195 dispatch preflight refusals are bounded and visible', () => {
  it('persists a blocked packet and human-required incident after bounded probes', async () => {
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-preflight-refused-2195',
      repoPath,
      packets: [refusedPacket()],
    });

    const turns = 12;
    for (let turn = 0; turn < turns; turn += 1) {
      await runHeadlessSprintTick();
    }

    const packet = onlyPersisted();
    expect(packet).toMatchObject({
      status: 'blocked',
      queueState: 'held',
      attemptCount: 0,
      maxAttempts: 2,
      preflightRefusals: 2,
      lastEventLabel: 'dispatch_preflight_refused',
    });
    expect(packet.blockedReason).toContain(preflight.detail);
    expect(packet.blockedReason).toMatch(/preflight refused 2\/2 attempts/i);
    expect(findLaneByPacket(packet.id)).toBeNull();
    expect(runtimeLaunch).not.toHaveBeenCalled();

    const probes = readFileSync(probeLogPath, 'utf8').trim().split('\n');
    expect(probes).toHaveLength(2);
    expect(probes.length).toBeLessThan(turns);
    expect(getDispatchBlocker(
      { ...packet, status: 'queued', queueState: 'queued', blockedReason: null },
      [packet],
    )).toMatch(/preflight refusals exceeded \(2\/2\)/i);

    const incidents = listInboxItems({ includeAllProjects: true })
      .filter((item) => item.packetId === packet.id && item.kind === 'bounded_retry_exhausted');
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      status: 'human_required',
      payload: {
        stage: 'dispatch_preflight',
        attempts: '2/2',
        errorMessage: expect.stringContaining(preflight.detail),
        question: expect.stringContaining(preflight.detail),
      },
    });
  });
});
