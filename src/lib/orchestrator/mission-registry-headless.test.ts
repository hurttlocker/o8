import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

process.env.CORTEX_IDE_DATA_DIR = mkdtempSync(join(os.tmpdir(), 'o8-mission-registry-'));
process.env.O8_DATA_DIR = process.env.CORTEX_IDE_DATA_DIR;

const launchMock = vi.hoisted(() => ({
  calls: [] as Array<{ packetId?: string; repoPath: string }>,
}));
const tempDirs: string[] = [];

vi.mock('@/lib/runtime/actions', () => ({
  launchRuntimeSurface: vi.fn(async (input: { packetId?: string; repoPath: string }) => {
    launchMock.calls.push({ packetId: input.packetId, repoPath: input.repoPath });
    return {
      ok: true,
      surfaceId: `codex-owned:${input.packetId ?? launchMock.calls.length}`,
      note: 'mock runtime launched',
      worktree: { path: input.repoPath },
    };
  }),
}));

function createTempRepo() {
  const repoPath = mkdtempSync(join(os.tmpdir(), 'o8-mission-registry-repo-'));
  tempDirs.push(repoPath);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' });
  git('init', '--initial-branch=main');
  writeFileSync(join(repoPath, 'README.md'), 'mission registry test\n');
  git('add', 'README.md');
  git('-c', 'user.email=test@o8.test', '-c', 'user.name=o8-test', 'commit', '-m', 'init');
  return repoPath;
}

function textContent(result: { content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> }) {
  return result.content.find((entry) => entry.type === 'text')?.text ?? '';
}

function parseMissionResult(result: { content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> }) {
  return JSON.parse(textContent(result)) as {
    missionId: string;
    packets: Array<{ id: string; title: string; wave: number }>;
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  launchMock.calls = [];
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('headless mission registry dispatch', () => {
  it('dispatches a non-current mission packet after a newer mission becomes current', async () => {
    const repoPath = createTempRepo();
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlText = String(url);
      if (urlText.includes('/supervisor/watch') || urlText.includes('/internal/realtime')) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const body = JSON.parse(String(init?.body ?? '{}'));
      const { createMission } = await import('@/lib/orchestrator/operator-mission-service/mission');
      const result = await createMission(body as Parameters<typeof createMission>[0]);
      return new Response(JSON.stringify({ ok: true, result }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const { handleCreateMission } = await import('@/lib/mcp/operator-handlers/mission');
    const first = parseMissionResult(await handleCreateMission({
      issues_inline: [{ title: 'registry mission A', body: 'first mission must still dispatch' }],
      repoPath,
      runtime: 'codex',
      dispatch: false,
    }));
    const second = parseMissionResult(await handleCreateMission({
      issues_inline: [{ title: 'registry mission B', body: 'second mission becomes current focus' }],
      repoPath,
      runtime: 'codex',
      dispatch: false,
    }));

    const { runHeadlessSprintTick } = await import('@/lib/orchestrator/headless-loop');
    const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
    const { findLaneByPacket } = await import('@/lib/lane/registry');

    expect(readOrchestratorControlPlaneState().missionId).toBe(second.missionId);
    await runHeadlessSprintTick();

    const firstPacketId = first.packets[0]?.id;
    expect(firstPacketId).toBeTruthy();
    expect(findLaneByPacket(firstPacketId!)?.id).toMatch(/^lane-/);
    expect(readOrchestratorControlPlaneState().missionId).toBe(second.missionId);
    expect(launchMock.calls.some((call) => call.packetId === firstPacketId)).toBe(true);
  }, 20_000);
});
