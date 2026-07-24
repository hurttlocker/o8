import { describe, expect, it, vi } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const execFile = vi.fn((...args: unknown[]) => {
  const callback = args[args.length - 1] as (
    error: Error | null,
    result: { stdout: string; stderr: string },
  ) => void;
  callback(null, { stdout: '', stderr: '' });
});
const listRepos = vi.fn(async () => []);
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
        kind: 'alert',
        detail: expect.stringContaining('preserved/packet-pkt-recoverable'),
      }),
    ]);
  });
});
