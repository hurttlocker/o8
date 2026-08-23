import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { OrchestratorMissionState, OrchestratorPacket, WorkerRouting } from '@/lib/orchestrator/types';

const testCacheRoot = join(process.cwd(), 'node_modules', '.cache');
mkdirSync(testCacheRoot, { recursive: true });
const dataDir = mkdtempSync(join(testCacheRoot, 'o8-spawned-agent-model-status-'));

process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
process.env.O8_SUBSCRIPTION_PROFILE = 'both';
process.env.O8_DISPATCH_MODEL = '';
process.env.O8_PARALLEL_CAP = '5';
process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';

const launchRuntimeSurfaceMock = vi.hoisted(() => vi.fn(async (payload: {
  runtime: string;
  repoPath: string;
  existingLaneId?: string;
  model?: string;
  claudeCodeModel?: string;
}) => ({
  ok: true,
  runtime: payload.runtime,
  surfaceId: `${payload.runtime}-owned:test-${payload.existingLaneId}`,
  note: 'test launch',
  cwd: payload.repoPath,
  repoPath: payload.repoPath,
  worktree: null,
  laneId: payload.existingLaneId ?? null,
  model: payload.claudeCodeModel ?? payload.model ?? null,
})));

vi.mock('@/lib/runtime/actions', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/runtime/actions')>(),
  launchRuntimeSurface: launchRuntimeSurfaceMock,
}));

vi.mock('@/lib/runtimes/shared/auth-detect', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/runtimes/shared/auth-detect')>(),
  assertRuntimeDispatchable: vi.fn(async () => undefined),
}));

vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: () => null }));

function makeRepo(): string {
  const repoPath = mkdtempSync(join(dataDir, 'repo-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' });
  git('init', '--initial-branch=main');
  writeFileSync(join(repoPath, 'README.md'), 'spawned agent model status test\n');
  git('add', 'README.md');
  git('-c', 'user.email=test@o8.test', '-c', 'user.name=o8-test', 'commit', '-m', 'init');
  return repoPath;
}

function packet(repoPath: string, id: string, routing: WorkerRouting): OrchestratorPacket {
  return {
    id,
    referenceLabel: id,
    title: id,
    summary: `Dispatch ${id}`,
    workspaceTargetPath: repoPath,
    branchTarget: `inline/${id}`,
    runtime: routing.selectedRuntime,
    dependencyLabels: [],
    dependencyPacketIds: [],
    queueState: 'queued',
    releaseState: 'pending',
    status: 'queued',
    lane: null,
    assignedModel: routing.selectedModel,
    workerRouting: routing,
  };
}

beforeAll(() => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true })));
});

afterAll(() => {
  vi.unstubAllGlobals();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('spawned agent resolved model status real path', () => {
  it('returns each launched model, including a cross-house fallback, through the real status route', async () => {
    const { MODEL_IDS } = await import('@/lib/models');
    const { resolveWorkerRouting } = await import('@/lib/agents/routing');
    const { resolveSubscriptionProfileRouting } = await import('@/lib/operator/subscription-profile');
    const codexRouting = resolveWorkerRouting({
      requestedRuntime: 'codex',
      requestedModel: 'gpt-5.6-sol',
      source: 'resolved-model-status-test',
    });
    const opencodeRouting = resolveWorkerRouting({
      requestedRuntime: 'opencode',
      requestedModel: 'opencode/ox-alpha',
      source: 'resolved-model-status-test',
    });
    const guarded = resolveSubscriptionProfileRouting({
      profile: 'both',
      requestedRuntime: 'claude-code',
      requestedModel: MODEL_IDS.codexDefault,
      defaultDispatchModel: MODEL_IDS.claudeWorkerDefault,
    });
    expect(guarded).toEqual({
      ok: true,
      requestedRuntime: 'claude-code',
      requestedModel: MODEL_IDS.claudeWorkerDefault,
    });
    if (!guarded.ok) throw new Error(guarded.message);
    const claudeRouting = resolveWorkerRouting({
      requestedRuntime: guarded.requestedRuntime,
      requestedModel: guarded.requestedModel,
      source: 'resolved-model-status-test-guarded',
    });

    const codexRepoPath = makeRepo();
    const opencodeRepoPath = makeRepo();
    const claudeRepoPath = makeRepo();
    const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
    const packets = [
      packet(codexRepoPath, 'codex-packet', codexRouting),
      packet(opencodeRepoPath, 'opencode-packet', opencodeRouting),
      packet(claudeRepoPath, 'guarded-claude-packet', claudeRouting),
    ];
    const { dispatch } = await import('@/lib/lane/commands');
    for (const candidate of packets) {
      const opened = await dispatch({
        verb: 'open_lane',
        repoPath: candidate.workspaceTargetPath!,
        branch: candidate.branchTarget,
        runtime: candidate.runtime,
        packetId: candidate.id,
        label: candidate.title,
        actor: 'orchestrator',
      });
      expect(opened.ok).toBe(true);
      const launched = await dispatch({
        verb: 'launch_session',
        laneId: opened.laneId,
        prompt: candidate.summary,
        model: candidate.workerRouting?.selectedModel ?? undefined,
        actor: 'orchestrator',
      });
      expect(launched.ok).toBe(true);
      candidate.status = 'running';
      candidate.lane = {
        tileId: 'test',
        tabId: 'test',
        repoPath: candidate.workspaceTargetPath,
        runtime: candidate.runtime,
        laneId: opened.laneId,
        sessionKey: launched.lane?.sessionKey ?? null,
      };
    }
    const state: OrchestratorMissionState = {
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-resolved-model-status',
      repoPath: codexRepoPath,
      packets,
    };
    expect(launchRuntimeSurfaceMock).toHaveBeenCalledTimes(3);

    const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
    writeOrchestratorControlPlaneState(state);
    const { NextRequest } = await import('next/server');
    const statusRoute = await import('@/app/api/orchestrator/status/route');
    const response = await statusRoute.GET(new NextRequest(
      'http://127.0.0.1/api/orchestrator/status?missionId=mission-resolved-model-status',
    ));
    expect(response.status).toBe(200);
    const payload = await response.json() as {
      result: {
        packets: Array<{ id: string; runtime: string; model: string | null; lane: { model: string | null } }>;
        agents: Array<{ packetId: string; runtime: string; model: string | null }>;
      };
    };

    const expected = new Map([
      ['codex-packet', ['codex', 'gpt-5.6-sol']],
      ['opencode-packet', ['opencode', 'opencode/ox-alpha']],
      ['guarded-claude-packet', ['claude-code', MODEL_IDS.claudeWorkerDefault]],
    ]);
    for (const [packetId, [runtime, model]] of expected) {
      expect(payload.result.packets.find((entry) => entry.id === packetId)).toMatchObject({
        runtime,
        model,
        lane: { model },
      });
      expect(payload.result.agents.find((entry) => entry.packetId === packetId)).toMatchObject({
        runtime,
        model,
      });
    }
    expect(payload.result.packets.find((entry) => entry.id === 'guarded-claude-packet')?.model)
      .not.toBe(MODEL_IDS.codexDefault);
  }, 30_000);
});
