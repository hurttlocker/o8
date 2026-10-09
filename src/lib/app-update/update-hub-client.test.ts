import { beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshCliUpdateView, synchronizeConnectedClis } from './update-hub-client';

const record = (runtimeId: string, status = 'current') => ({ runtimeId, label: runtimeId, status, installedVersion: '2.0.1',
  latestVersion: '2.0.2', selectedPath: `/fixture/${runtimeId}`, updateUrl: 'https://example.test' });
const report = (status = 'current') => ({ tools: [record('codex', status), record('claude-code', 'not-installed'), record('grok', 'not-installed')] });
beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
describe('the connected CLI synchronization gate', () => {
  it('shares one check and updates only installed connected providers before verifying the final report', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(report('update-available')))
      .mockResolvedValueOnce(Response.json({ status: 'succeeded' })).mockResolvedValueOnce(Response.json(report()));
    await Promise.all([synchronizeConnectedClis(), synchronizeConnectedClis()]);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(vi.mocked(fetch).mock.calls[1]?.[1]).toMatchObject({ method: 'POST', body: '{"runtime":"codex"}' });
  });
  it.each(['failed', 'outdated', 'disappeared'])('rejects a %s final check so an app install cannot proceed', async failure => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(report('update-available')))
      .mockResolvedValueOnce(Response.json({ status: 'succeeded' }))
      .mockResolvedValueOnce(failure === 'failed' ? new Response(null, { status: 503 }) : Response.json(report(failure === 'outdated' ? 'update-available' : 'not-installed')));
    await expect(synchronizeConnectedClis()).rejects.toThrow();
  });
  it('rejects incomplete reports and unavailable release checks without running an installer', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ tools: [] }));
    await expect(synchronizeConnectedClis()).rejects.toThrow('incomplete');
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(report('unknown')));
    await expect(synchronizeConnectedClis()).rejects.toThrow('release');
    expect(vi.mocked(fetch).mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });
  it('keeps a read-only refresh separate from the install action', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(report('update-available')));
    await refreshCliUpdateView(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.method).toBeUndefined();
  });
});
