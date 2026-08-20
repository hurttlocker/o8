import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

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

const tempDirs: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function createRepo(options: { mainOnlyCommit?: boolean } = {}): string {
  const repoPath = mkdtempSync(join(os.tmpdir(), 'o8-branch-binding-'));
  tempDirs.push(repoPath);
  git(repoPath, 'init', '--initial-branch=main');
  git(repoPath, 'config', 'user.email', 'test@o8.test');
  git(repoPath, 'config', 'user.name', 'o8-test');
  writeFileSync(join(repoPath, 'README.md'), 'base\n');
  git(repoPath, 'add', 'README.md');
  git(repoPath, 'commit', '-m', 'base');
  if (options.mainOnlyCommit) {
    git(repoPath, 'branch', 'base');
    writeFileSync(join(repoPath, 'main-only.txt'), 'must never appear in a packet diff\n');
    git(repoPath, 'add', 'main-only.txt');
    git(repoPath, 'commit', '-m', 'main-only change');
  }
  return repoPath;
}

function resultJson(result: { content: Array<{ type: 'text'; text: string } | { type: 'image' }> }) {
  const text = result.content.find((entry) => entry.type === 'text')?.text ?? '';
  return JSON.parse(text) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('lane branch binding and governance diff targets', () => {
  it('trims a separator at the slug boundary and keeps lane.branch equal to the created git branch', async () => {
    const repoPath = createRepo();
    const title = `${'a'.repeat(47)} trailing words`;
    const { createMission } = await import('@/lib/orchestrator/operator-mission-service/mission');
    const { currentMissionState } = await import('@/lib/orchestrator/operator-mission-service/shared');
    await createMission({
      issues: [{
        number: 1591,
        title,
        body: '',
        url: 'https://github.com/o8/o8/issues/1591',
      }],
      repoPath,
      runtime: 'codex',
      constraints: '',
    });
    const packet = currentMissionState().packets[0]!;
    expect(packet.branchTarget).not.toMatch(/[-/.]$/);

    const { dispatch } = await import('@/lib/lane/commands');
    const opened = await dispatch({
      verb: 'open_lane',
      repoPath,
      branch: packet.branchTarget,
      baseBranch: 'main',
      runtime: 'codex',
      packetId: packet.id,
      actor: 'orchestrator',
    });
    expect(opened.ok).toBe(true);

    const previousSkip = process.env.O8_SKIP_PRELAUNCH_TYPECHECK;
    process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';
    const { prepareLaunchWorktree } = await import('@/lib/worktree/launch');
    const launch = await prepareLaunchWorktree({
      repoRoot: repoPath,
      agentType: 'codex',
      taskName: packet.title,
      branchName: opened.lane!.branch,
      baseBranch: 'main',
      isolate: true,
      skipSetup: true,
      packetId: packet.id,
    }).finally(() => {
      if (previousSkip === undefined) delete process.env.O8_SKIP_PRELAUNCH_TYPECHECK;
      else process.env.O8_SKIP_PRELAUNCH_TYPECHECK = previousSkip;
    });
    expect(launch).toBeTruthy();

    const bound = await dispatch({
      verb: 'bind_worktree',
      laneId: opened.laneId!,
      worktreePath: launch!.cwd,
      actor: 'orchestrator',
    });
    const actualBranch = git(launch!.cwd, 'branch', '--show-current');
    expect(bound.lane?.branch).toBe(actualBranch);
    expect(launch!.worktree?.branch).toBe(actualBranch);
  }, 20_000);

  it('returns branch_unresolved from packet diff and merge preview instead of diffing main', async () => {
    const repoPath = createRepo({ mainOnlyCommit: true });
    expect(git(repoPath, 'diff', 'base...main', '--name-only')).toContain('main-only.txt');

    const packetId = 'pkt-unresolved-governance-target';
    const { createLane } = await import('@/lib/lane/registry');
    const lane = createLane({
      repoPath,
      branch: 'issue/1591-unresolvable-recorded-branch-',
      baseBranch: 'base',
      runtime: 'codex',
      packetId,
    });
    const { NextRequest } = await import('next/server');
    const diffRoute = await import('@/app/api/lanes/[id]/diff/route');
    const previewRoute = await import('@/app/api/orchestrator/merge-preview/route');
    const operatorGet = (url: string) => new NextRequest(url, {
      method: 'GET',
      headers: { host: 'localhost:3001' },
    });

    const diffResponse = await diffRoute.GET(
      operatorGet(`http://localhost:3001/api/lanes/${lane.id}/diff`),
      { params: Promise.resolve({ id: lane.id }) },
    );
    expect(diffResponse.status).toBe(409);
    const diffPayload = await diffResponse.json();
    expect(diffPayload).toMatchObject({
      ok: false,
      error: { code: 'branch_unresolved', laneId: lane.id, branch: lane.branch },
    });
    expect(diffPayload).not.toHaveProperty('diff');

    const previewResponse = await previewRoute.GET(
      operatorGet(`http://localhost:3001/api/orchestrator/merge-preview?packetId=${packetId}`),
    );
    expect(previewResponse.status).toBe(409);
    await expect(previewResponse.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'branch_unresolved', laneId: lane.id, branch: lane.branch },
    });

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/diff')) {
        const id = decodeURIComponent(parsed.pathname.split('/').at(-2)!);
        return diffRoute.GET(operatorGet(url), { params: Promise.resolve({ id }) });
      }
      if (parsed.pathname === '/api/orchestrator/merge-preview') {
        return previewRoute.GET(operatorGet(url));
      }
      throw new Error(`Unhandled test URL: ${url}`);
    }));

    const { handlePacketDiff } = await import('@/lib/mcp/operator-handlers/mission');
    const packetDiffResult = await handlePacketDiff({ laneId: lane.id });
    expect(packetDiffResult.isError).toBe(true);
    expect(resultJson(packetDiffResult)).toMatchObject({
      ok: false,
      error: { code: 'branch_unresolved', laneId: lane.id },
    });

    const { handleMergePreview } = await import('@/lib/mcp/operator-handlers/approve');
    const mergePreviewResult = await handleMergePreview({ packetId });
    expect(mergePreviewResult.isError).toBe(true);
    expect(resultJson(mergePreviewResult)).toMatchObject({
      ok: false,
      error: { code: 'branch_unresolved', laneId: lane.id },
    });
  });
});
