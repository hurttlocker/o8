import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const execFile = vi.fn((...args: unknown[]) => {
  const callback = args[args.length - 1] as (
    error: Error | null,
    result: { stdout: string; stderr: string },
  ) => void;
  callback(null, { stdout: '', stderr: '' });
});
const listRepos = vi.fn<() => Promise<Array<{
  id: string;
  name: string;
  localPath: string;
}>>>(async () => []);
const syncOrchestratorControlPlaneState = vi.fn();

vi.mock('node:child_process', () => ({ execFile }));
vi.mock('@/lib/repos/registry', () => ({ listRepos }));
vi.mock('@/lib/lane/registry', () => ({
  findLaneByPacket: vi.fn(() => null),
  getLaneEvents: vi.fn(() => []),
}));
vi.mock('@/lib/orchestrator/control-plane', () => ({
  syncOrchestratorControlPlaneState,
}));

const { GET } = await import('@/app/api/mobile/activity/route');

describe('mobile activity route', () => {
  beforeEach(() => {
    execFile.mockReset();
    execFile.mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1] as (
        error: Error | null,
        result: { stdout: string; stderr: string },
      ) => void;
      callback(null, { stdout: '', stderr: '' });
    });
    listRepos.mockReset();
    listRepos.mockResolvedValue([]);
    syncOrchestratorControlPlaneState.mockReset();
    syncOrchestratorControlPlaneState.mockResolvedValue({ packets: [] });
  });

  it('observes bounded Git activity across all refs with source-neutral provenance', async () => {
    const recordSeparator = '\u001e';
    const fieldSeparator = '\u001f';
    const featureSha = '1111111111111111111111111111111111111111';
    const remoteSha = '2222222222222222222222222222222222222222';
    listRepos.mockResolvedValue([{
      id: 'repo-o8',
      name: 'o8',
      localPath: '/tmp/o8',
    }]);
    execFile.mockImplementation((...args: unknown[]) => {
      const gitArgs = args[1] as string[];
      const callback = args[args.length - 1] as (
        error: Error | null,
        result: { stdout: string; stderr: string },
      ) => void;
      if (gitArgs.includes('log')) {
        callback(null, {
          stdout: [
            `${recordSeparator}${featureSha}${fieldSeparator}refs/heads/feature/offline-work${fieldSeparator}parent-a${fieldSeparator}Sydney${fieldSeparator}Build outside o8${fieldSeparator}2026-07-30T18:30:00.000Z`,
            `${recordSeparator}${remoteSha}${fieldSeparator}refs/remotes/origin/review${fieldSeparator}parent-b parent-c${fieldSeparator}Marquise${fieldSeparator}Merge reviewed work${fieldSeparator}2026-07-30T18:00:00.000Z`,
          ].join(''),
          stderr: '',
        });
        return;
      }
      callback(null, { stdout: '', stderr: '' });
    });

    const response = await GET(new Request('http://localhost:3001/api/mobile/activity'));
    const payload = await response.json();
    const gitInvocation = execFile.mock.calls.find((call) =>
      Array.isArray(call[1]) && (call[1] as string[]).includes('log')
    );
    const gitArgs = gitInvocation?.[1] as string[];

    expect(gitArgs).toEqual(expect.arrayContaining([
      '-C',
      '/tmp/o8',
      'log',
      '--all',
      '--source',
      '--max-count=20',
    ]));
    expect(gitArgs).not.toContain('fetch');
    expect(gitArgs).not.toContain('pull');
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(payload.events).toEqual([
      expect.objectContaining({
        id: `commit:${featureSha}`,
        source: 'git',
        commitSha: featureSha,
        author: 'Sydney',
        observedRef: 'feature/offline-work',
        detail: 'feature/offline-work · 1111111',
        kind: 'commit',
      }),
      expect.objectContaining({
        id: `commit:${remoteSha}`,
        source: 'git',
        commitSha: remoteSha,
        author: 'Marquise',
        observedRef: 'origin/review',
        detail: 'origin/review · 2222222',
        kind: 'merge',
      }),
    ]);
  });

  it('surfaces archived recoverable packet work as an alert with its preserved ref', async () => {
    syncOrchestratorControlPlaneState.mockResolvedValue({
      packets: [{
        id: 'pkt-recoverable',
        title: 'Preserved review',
        workspaceTargetPath: '/tmp/o8',
        branchTarget: 'preserved/packet-pkt-recoverable',
        releaseState: 'pending',
        status: 'archived',
        archivedAt: '2026-07-23T12:00:00.000Z',
        recovery: {
          outcome: 'archived_recoverable',
          preservedRef: 'preserved/packet-pkt-recoverable',
          preservedHeadSha: 'abc123',
          message: 'Reviewed work preserved at preserved/packet-pkt-recoverable — retry/redispatch to resume.',
          recommendedAction: 'retry_packet',
        },
      } as OrchestratorPacket],
    });

    const response = await GET(new Request('http://localhost:3001/api/mobile/activity'));
    const payload = await response.json();

    expect(payload.events).toEqual([
      expect.objectContaining({
        id: 'packet:pkt-recoverable',
        source: 'orchestrator',
        kind: 'alert',
        detail: expect.stringContaining('preserved/packet-pkt-recoverable'),
      }),
    ]);
  });
});
