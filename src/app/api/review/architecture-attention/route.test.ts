import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  requirePanelAuth: vi.fn((): NextResponse | null => null),
  getLane: vi.fn(),
  findLane: vi.fn(),
  readLaneReviewDiff: vi.fn(),
  buildArchitectureDelta: vi.fn(),
  rankArchitectureAttention: vi.fn(),
}));

vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: h.requirePanelAuth }));
vi.mock('@/lib/lane/registry', () => ({ getLane: h.getLane, findLatestLaneByPacket: h.findLane }));
vi.mock('@/lib/lane/review-source', () => ({ readLaneReviewDiff: h.readLaneReviewDiff }));
vi.mock('@/lib/review/architecture-attention', () => ({ rankArchitectureAttention: h.rankArchitectureAttention }));
vi.mock('@/lib/review/architecture-delta', () => ({
  ArchitectureDeltaInputError: class ArchitectureDeltaInputError extends Error {},
  buildArchitectureDelta: h.buildArchitectureDelta,
  unavailableArchitectureDelta: (reason: string) => ({ ok: true, status: 'unavailable', reason, nodes: [], edges: [] }),
}));

const { POST } = await import('./route');

const analysisId = 'a'.repeat(24);
const delta = {
  ok: true,
  status: 'ready',
  reason: null,
  analysisId,
  nodes: [
    { path: 'src/a.ts', state: 'changed', focusPath: 'src/a.ts' },
    { path: 'src/b.ts', state: 'changed', focusPath: 'src/b.ts' },
  ],
  edges: [],
  summary: { changedModules: 2, addedEdges: 0, removedEdges: 0, contextEdges: 0 },
  unsupportedPaths: [],
  omittedPaths: [],
  resolutionWarnings: [],
  truncated: false,
  generatedAt: '2026-09-21T00:00:00.000Z',
};

function request(expected = analysisId) {
  return new NextRequest('http://localhost/api/review/architecture-attention?lane=lane-1', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedAnalysisId: expected, scopePaths: ['src/a.ts'] }),
  });
}

function requestWithBody(body: string) {
  return new NextRequest('http://localhost/api/review/architecture-attention?lane=lane-1', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

describe('POST /api/review/architecture-attention', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.requirePanelAuth.mockReturnValue(null);
    h.getLane.mockReturnValue({ id: 'lane-1' });
    h.findLane.mockReturnValue(null);
    h.readLaneReviewDiff.mockResolvedValue({
      source: { kind: 'materialized', cwd: '/worktree' },
      diffBase: { mergeBase: 'base-sha', comparisonRef: 'main' },
    });
    h.buildArchitectureDelta.mockResolvedValue(delta);
    h.rankArchitectureAttention.mockResolvedValue({ ok: true, status: 'ready', analysisId, items: [] });
  });

  it('rebuilds the trusted graph, applies the active Review scope, and ranks that evidence', async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(h.buildArchitectureDelta).toHaveBeenCalledWith({ repoPath: '/worktree', baseRef: 'base-sha' });
    expect(h.rankArchitectureAttention).toHaveBeenCalledWith(expect.objectContaining({
      nodes: [expect.objectContaining({ path: 'src/a.ts' })],
      summary: expect.objectContaining({ changedModules: 1 }),
    }), { laneId: 'lane-1', repoPath: '/worktree' });
  });

  it('passes the workspace identity for reviews without a lane', async () => {
    const workspaceRequest = new NextRequest('http://localhost/api/review/architecture-attention?workspace=%2Frepo-b', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedAnalysisId: analysisId, scopePaths: ['src/a.ts'] }),
    });

    const response = await POST(workspaceRequest);

    expect(response.status).toBe(200);
    expect(h.buildArchitectureDelta).toHaveBeenCalledWith({ repoPath: '/repo-b' });
    expect(h.rankArchitectureAttention).toHaveBeenCalledWith(expect.anything(), {
      laneId: null,
      repoPath: '/repo-b',
    });
  });

  it('rejects stale evidence before making an advisory model call', async () => {
    const response = await POST(request('b'.repeat(24)));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ kind: 'stale_analysis' });
    expect(h.rankArchitectureAttention).not.toHaveBeenCalled();
  });

  it('returns structured errors for primitive bodies and empty Review scopes', async () => {
    const primitive = await POST(requestWithBody('null'));
    expect(primitive.status).toBe(400);
    await expect(primitive.json()).resolves.toMatchObject({ error: 'A JSON object request body is required.' });

    const emptyScope = await POST(requestWithBody(JSON.stringify({ expectedAnalysisId: analysisId, scopePaths: [] })));
    expect(emptyScope.status).toBe(400);
    await expect(emptyScope.json()).resolves.toMatchObject({ error: 'Review scope paths are invalid.' });
    expect(h.buildArchitectureDelta).not.toHaveBeenCalled();
    expect(h.rankArchitectureAttention).not.toHaveBeenCalled();
  });
});
