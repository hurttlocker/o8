import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requirePanelAuthMock, getRuntimeEvidenceSnapshotMock } = vi.hoisted(() => ({
  requirePanelAuthMock: vi.fn(),
  getRuntimeEvidenceSnapshotMock: vi.fn(),
}));

vi.mock('@/lib/panel/auth', () => ({
  requirePanelAuth: requirePanelAuthMock,
}));

vi.mock('@/lib/runtime/runtime-evidence', () => ({
  getRuntimeEvidenceSnapshot: getRuntimeEvidenceSnapshotMock,
}));

import { GET } from './route';

describe('GET /api/runtime/evidence', () => {
  beforeEach(() => {
    requirePanelAuthMock.mockReset().mockReturnValue(null);
    getRuntimeEvidenceSnapshotMock.mockReset().mockResolvedValue({
      schema: 'o8/runtime-evidence/v1',
      generatedAt: '2026-08-14T12:00:00.000Z',
      runtimes: [],
    });
  });

  it('passes refresh and repository scope to the production evidence service', async () => {
    const response = await GET(new NextRequest(
      'http://localhost/api/runtime/evidence?fresh=1&repoPath=%2Ftmp%2Frepo',
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store, max-age=0');
    expect(getRuntimeEvidenceSnapshotMock).toHaveBeenCalledWith({
      fresh: true,
      repoPath: '/tmp/repo',
    });
    await expect(response.json()).resolves.toMatchObject({ schema: 'o8/runtime-evidence/v1' });
  });

  it('honors the route authentication boundary', async () => {
    const denied = new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    requirePanelAuthMock.mockReturnValue(denied);

    const response = await GET(new NextRequest('http://localhost/api/runtime/evidence'));

    expect(response).toBe(denied);
    expect(getRuntimeEvidenceSnapshotMock).not.toHaveBeenCalled();
  });
});
