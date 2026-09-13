import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

process.env.CORTEX_IDE_DATA_DIR = mkdtempSync(join(os.tmpdir(), 'o8-mission-staging-'));
process.env.O8_DATA_DIR = process.env.CORTEX_IDE_DATA_DIR;

const launches = vi.hoisted(() => ({ calls: [] as Array<{ packetId?: string; repoPath: string }> }));
const dispatchFailure = vi.hoisted(() => ({ once: false }));
const tempDirs: string[] = [];

vi.mock('@/lib/worktree/storage-telemetry', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/worktree/storage-telemetry')>(),
  measureHostVolume: vi.fn(async () => ({
    accountingStatus: 'observed' as const,
    probePath: '/', availableBytes: 90_000_000_000, freeBytes: 90_000_000_000,
    totalBytes: 100_000_000_000, error: null,
  })),
}));

vi.mock('@/lib/runtime/actions', () => ({
  launchRuntimeSurface: vi.fn(async (input: { packetId?: string; repoPath: string }) => {
    launches.calls.push({ packetId: input.packetId, repoPath: input.repoPath });
    return { ok: true, surfaceId: `codex-owned:${input.packetId}`, note: 'fixture launch', worktree: { path: input.repoPath } };
  }),
}));
vi.mock('@/lib/runtimes/shared/auth-detect', () => ({ assertRuntimeDispatchable: vi.fn(async () => undefined) }));

function createTempRepo() {
  const repoPath = mkdtempSync(join(os.tmpdir(), 'o8-mission-staging-repo-'));
  tempDirs.push(repoPath);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' });
  git('init', '--initial-branch=main');
  writeFileSync(join(repoPath, 'README.md'), 'mission staging fixture\n');
  git('add', 'README.md');
  git('-c', 'user.email=test@o8.test', '-c', 'user.name=o8-test', 'commit', '-m', 'init');
  return repoPath;
}

type McpResult = { content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> };

function textContent(result: McpResult) {
  return result.content.find((entry) => entry.type === 'text')?.text ?? '';
}

function parseResult<T>(result: McpResult) {
  return JSON.parse(textContent(result)) as T;
}

function stubMissionApiFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlText = String(url);
    if (urlText.includes('/supervisor/watch') || urlText.includes('/internal/realtime')) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (urlText.includes('/dispatch') && dispatchFailure.once) {
      dispatchFailure.once = false;
      return new Response(JSON.stringify({ ok: false, error: { message: 'interrupted fixture dispatch' } }), { status: 500 });
    }
    try {
      if (urlText.includes('/create-mission')) {
        const [{ NextRequest }, { POST }] = await Promise.all([
          import('next/server'),
          import('@/app/api/orchestrator/create-mission/route'),
        ]);
        return POST(new NextRequest(urlText, {
          method: 'POST',
          headers: { host: 'localhost:47120', 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }));
      }
      const { dispatchMission } = await import('@/lib/orchestrator/operator-mission-service/mission');
      return new Response(JSON.stringify({ ok: true, result: await dispatchMission(body) }), { status: 200 });
    } catch (error) {
      return new Response(JSON.stringify({ ok: false, error: { message: String(error) } }), { status: 500 });
    }
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  launches.calls = [];
  dispatchFailure.once = false;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('staged mission creation', () => {
  it('keeps comparison candidates staged until explicit dispatch and preserves MCP immediate dispatch', async () => {
    const repoPath = createTempRepo();
    stubMissionApiFetch();
    const { handleCreateMission } = await import('@/lib/mcp/operator-handlers/mission');
    const staged = parseResult<{ missionId: string; packets: Array<{ id: string }> }>(await handleCreateMission({
      issues_inline: [{ title: 'staged comparison mission', body: 'Wait for explicit dispatch.' }],
      repoPath, runtime: 'codex', comparisonModels: ['gpt-5.6-sol', 'gpt-5.6-sol'], dispatch: false,
    }));

    const { runHeadlessSprintTick } = await import('@/lib/orchestrator/headless-loop');
    await runHeadlessSprintTick();
    expect(launches.calls).toEqual([]);
    const { currentMissionState } = await import('@/lib/orchestrator/operator-mission-service/shared');
    expect(currentMissionState().packets).toEqual(expect.arrayContaining([
      expect.objectContaining({ queueState: 'held', lane: null, review: null }),
    ]));

    const { dispatchMission } = await import('@/lib/orchestrator/operator-mission-service/mission');
    expect(await dispatchMission({ missionId: staged.missionId })).toMatchObject({ dispatched: 2 });
    expect(launches.calls).toHaveLength(2);

    // The MCP response is intentionally fire-and-forget. If that first call is
    // interrupted, the create-time admission intent leaves this packet queued
    // for the real scheduler instead of stranding it in the held staging state.
    dispatchFailure.once = true;
    const immediate = parseResult<{ missionId: string; packets: Array<{ id: string }> }>(await handleCreateMission({
      issues_inline: [{ title: 'immediate MCP mission' }], repoPath, runtime: 'codex',
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(launches.calls).toHaveLength(2);
    expect(currentMissionState().packets.find((packet) => packet.id === immediate.packets[0]?.id)).toMatchObject({
      queueState: 'queued', status: 'queued', runtime: 'codex',
    });
    await runHeadlessSprintTick();
    await vi.waitFor(() => expect(currentMissionState().packets.find((packet) => packet.id === immediate.packets[0]?.id)?.lane?.laneId).toMatch(/^lane-/));
    expect(launches.calls).toHaveLength(3);
    await runHeadlessSprintTick();
    expect(launches.calls).toHaveLength(3);
  }, 20_000);
});
