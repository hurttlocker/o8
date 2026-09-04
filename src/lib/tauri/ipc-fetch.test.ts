import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock('./bridge', () => ({ isTauri: () => true }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));

const { ipcFetch } = await import('./ipc-fetch');

describe('ipcFetch repo query routing', () => {
  afterEach(() => {
    mocks.fetch.mockReset();
    mocks.invoke.mockReset();
    vi.unstubAllGlobals();
  });

  it('keeps the raw repository list on the native fast path', async () => {
    mocks.invoke.mockResolvedValue({ repos: [{ id: 'repo-a' }] });

    const response = await ipcFetch('/api/panel/repos');

    expect(mocks.invoke).toHaveBeenCalledWith('read_repos', {});
    expect(await response.json()).toEqual({ repos: [{ id: 'repo-a' }] });
  });

  it('sends query-specific repository reads through the HTTP route', async () => {
    mocks.fetch.mockResolvedValue(Response.json({ repos: [{ id: 'repo-a', readiness: { state: 'ready' } }] }));
    vi.stubGlobal('fetch', mocks.fetch);

    const response = await ipcFetch('/api/panel/repos?readiness=repo-a');

    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.fetch).toHaveBeenCalledWith('/api/panel/repos?readiness=repo-a', undefined);
    expect(await response.json()).toEqual({ repos: [{ id: 'repo-a', readiness: { state: 'ready' } }] });
  });
});
