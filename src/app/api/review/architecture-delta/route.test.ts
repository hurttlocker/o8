import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  requirePanelAuth: vi.fn((): NextResponse | null => null),
  getLane: vi.fn(),
  findLane: vi.fn(),
  readLaneReviewDiff: vi.fn(),
  buildArchitectureDelta: vi.fn(),
}));

vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: h.requirePanelAuth }));
vi.mock('@/lib/lane/registry', () => ({
  getLane: h.getLane,
  findLatestLaneByPacket: h.findLane,
}));
vi.mock('@/lib/lane/review-source', () => ({ readLaneReviewDiff: h.readLaneReviewDiff }));
vi.mock('@/lib/review/architecture-delta', () => ({
  ArchitectureDeltaInputError: class ArchitectureDeltaInputError extends Error {},
  buildArchitectureDelta: h.buildArchitectureDelta,
  unavailableArchitectureDelta: (reason: string) => ({ ok: true, status: 'unavailable', reason }),
}));

const { GET } = await import('./route');

const result = {
  ok: true,
  status: 'ready',
  reason: null,
  nodes: [],
  edges: [],
  summary: { changedModules: 0, addedEdges: 0, removedEdges: 0, contextEdges: 0 },
  unsupportedPaths: [],
  omittedPaths: [],
  resolutionWarnings: [],
  truncated: false,
  generatedAt: '2026-09-21T00:00:00.000Z',
};

function request(laneId: string) {
  return new NextRequest(`http://localhost/api/review/architecture-delta?lane=${laneId}`);
}

describe('GET /api/review/architecture-delta lane boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.requirePanelAuth.mockReturnValue(null);
    h.getLane.mockReturnValue({ id: 'lane-1', packetId: 'packet-1' });
    h.findLane.mockReturnValue(null);
    h.readLaneReviewDiff.mockResolvedValue({
      source: { kind: 'materialized', cwd: '/worktrees/packet-1' },
      diffBase: { mergeBase: 'base-sha', comparisonRef: 'main' },
    });
    h.buildArchitectureDelta.mockResolvedValue(result);
  });

  it('analyzes the persisted lane materialization against its resolved merge base', async () => {
    const response = await GET(request('lane-1'));

    expect(response.status).toBe(200);
    expect(h.readLaneReviewDiff).toHaveBeenCalledWith(expect.objectContaining({ id: 'lane-1' }));
    expect(h.buildArchitectureDelta).toHaveBeenCalledWith({
      repoPath: '/worktrees/packet-1',
      baseRef: 'base-sha',
    });
  });

  it('does not analyze a parked lane without a materialized checkout', async () => {
    h.readLaneReviewDiff.mockResolvedValue({
      source: { kind: 'parked' },
      diffBase: { mergeBase: 'base-sha', comparisonRef: 'main' },
    });

    const response = await GET(request('lane-1'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, status: 'unavailable' });
    expect(h.buildArchitectureDelta).not.toHaveBeenCalled();
  });
});
