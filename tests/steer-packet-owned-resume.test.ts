import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const performRuntimeActionMock = vi.hoisted(() => vi.fn());
const ensureDispatchBackendReadyMock = vi.hoisted(() => vi.fn(async () => ({
  ready: true,
  reason: 'already_ready',
  waitedMs: 0,
  attempts: 0,
})));

vi.mock('@/lib/runtime/actions', () => ({
  performRuntimeAction: performRuntimeActionMock,
}));

vi.mock('@/lib/runtimes/shared/dispatch-readiness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runtimes/shared/dispatch-readiness')>();
  return {
    ...actual,
    ensureDispatchBackendReady: ensureDispatchBackendReadyMock,
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    // A LIVE pid — the steer startup-failure probe (#1432) checks whether the
    // resume run it spawned actually came alive; a fake dead pid reads as
    // 'Steer failed to start'. The test process itself is the liveness stand-in.
    spawn: vi.fn(() => ({ pid: process.pid, unref: vi.fn(), once: vi.fn() })),
  };
});

const tempDirs: string[] = [];

afterEach(() => {
  performRuntimeActionMock.mockReset();
  ensureDispatchBackendReadyMock.mockClear();
  vi.mocked(spawn).mockClear();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('steerPacket owned Codex resume fallback', () => {
  it('resumes an exited owned Codex session from its persisted thread id instead of refusing', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'o8-owned-codex-steer-'));
    const repoPath = mkdtempSync(path.join(os.tmpdir(), 'o8-owned-codex-repo-'));
    tempDirs.push(root, repoPath);
    process.env.CORTEX_IDE_OWNED_CODEX_ROOT = root;
    process.env.O8_CODEX_BIN = process.execPath;

    const sessionId = 'codex-owned-steer-resume';
    const surfaceId = `codex-owned:${sessionId}`;
    const threadId = 'thread-steer-resume-1';
    const sessionDir = path.join(root, sessionId);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify({
      surfaceId,
      sessionDir,
      cwd: repoPath,
      repoPath,
      title: 'owned resume repo',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      threadId,
      latestPrompt: 'previous turn',
      latestSummary: 'previous turn',
      reviewDisposition: 'watching',
      recentRuns: [],
      activeRun: {
        id: 'dead-run',
        mode: 'launch',
        prompt: 'previous turn',
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        pid: 987654321,
        stdoutPath: path.join(sessionDir, 'runs', 'dead-run.jsonl'),
        stderrPath: path.join(sessionDir, 'runs', 'dead-run.stderr.log'),
        outcome: 'running',
      },
    }, null, 2));

    performRuntimeActionMock.mockResolvedValue({
      ok: false,
      action: 'steer',
      surfaceId,
      sessionKey: surfaceId,
      runtime: 'codex',
      status: 'unavailable',
      note: 'Runtime surface not found.',
    });

    const { createLane, getLane } = await import('@/lib/lane/registry');
    const { steerPacket } = await import('@/lib/orchestrator/operator-mission-service/steer');

    const lane = createLane({
      repoPath,
      branch: 'inline/owned-resume',
      runtime: 'codex',
      packetId: 'pkt-owned-resume',
      sessionKey: surfaceId,
    });

    await expect(steerPacket({
      packetId: 'pkt-owned-resume',
      message: 'continue from huddle approval',
    })).resolves.toMatchObject({
      packetId: 'pkt-owned-resume',
      laneId: lane.id,
      // #1524 — the fallback resume's own note passes through (warm resume
      // here; an archived session would read 'Cold resume: …').
      note: expect.stringContaining('via resume'),
    });

    expect(performRuntimeActionMock).toHaveBeenCalledWith({
      action: 'steer',
      surfaceId,
      clientMutationId: undefined,
      message: 'continue from huddle approval',
      auditSteer: false,
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spawn).mock.calls[0]?.[1]).toEqual(expect.arrayContaining([
      'exec',
      'resume',
      threadId,
      'continue from huddle approval',
    ]));
    expect(getLane(lane.id)?.status).toBe('running');
  }, 20_000);
});
