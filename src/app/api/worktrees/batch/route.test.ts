import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  requirePanelAuth: vi.fn(),
  getWorktreeManager: vi.fn(),
}));

vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: h.requirePanelAuth }));
vi.mock('@/lib/worktree/launch', () => ({ getWorktreeManager: h.getWorktreeManager }));

import { POST } from './route';

function request(repoPaths: unknown) {
  return new NextRequest('http://127.0.0.1/api/worktrees/batch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repoPaths }),
  });
}

describe('POST /api/worktrees/batch', () => {
  beforeEach(() => {
    h.requirePanelAuth.mockReset().mockReturnValue(null);
    h.getWorktreeManager.mockReset();
  });

  it('bounds concurrent repository scans and returns every result', async () => {
    let active = 0;
    let peak = 0;
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    h.getWorktreeManager.mockImplementation((repoPath: string) => ({
      list: async () => {
        active += 1;
        started += 1;
        peak = Math.max(peak, active);
        if (started <= 4) await gate;
        active -= 1;
        return [{ id: repoPath }];
      },
    }));

    const pending = POST(request(Array.from({ length: 12 }, (_, index) => `/repo-${index}`)));
    await vi.waitFor(() => expect(started).toBe(4));
    expect(peak).toBe(4);
    release();

    const response = await pending;
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(Object.keys(payload)).toHaveLength(12);
    expect(peak).toBe(4);
  });

  it('deduplicates paths and isolates a failed repository scan', async () => {
    h.getWorktreeManager.mockImplementation((repoPath: string) => ({
      list: async () => {
        if (repoPath === '/broken') throw new Error('unavailable');
        return [{ id: repoPath }];
      },
    }));

    const response = await POST(request(['/repo/', '/repo', '/broken']));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      '/repo': [{ id: '/repo' }],
      '/broken': [],
    });
    expect(h.getWorktreeManager).toHaveBeenCalledTimes(2);
  });

  it('rejects non-string repository paths before scanning', async () => {
    const response = await POST(request(['/repo', 7]));

    expect(response.status).toBe(400);
    expect(h.getWorktreeManager).not.toHaveBeenCalled();
  });

  it('rejects oversized batches before scanning any repository', async () => {
    const response = await POST(request(
      Array.from({ length: 65 }, (_, index) => `/repo-${index}`),
    ));

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ maxRepoPaths: 64 });
    expect(h.getWorktreeManager).not.toHaveBeenCalled();
  });
});
