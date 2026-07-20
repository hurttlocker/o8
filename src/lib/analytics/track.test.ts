import { afterEach, describe, expect, it, vi } from 'vitest';

import { track } from './track';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('browser product telemetry consent', () => {
  it('does not treat missing legacy browser state as consent', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => null) });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      void input;
      void init;
      return Response.json({ enabled: false });
    });
    vi.stubGlobal('fetch', fetchMock);

    track('app.opened');

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', cache: 'no-store' });
  });

  it('posts the sanitized event only after the persisted consent probe returns true', async () => {
    vi.stubGlobal('window', {});
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => (
      init?.method === 'GET'
        ? Response.json({ enabled: true })
        : Response.json({ ok: true, emitted: true })
    ));
    vi.stubGlobal('fetch', fetchMock);

    track('repo.added', { hasRemote: true, isGitRepo: true });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ event: 'repo.added', props: { hasRemote: true, isGitRepo: true } }),
    });
  });
});
