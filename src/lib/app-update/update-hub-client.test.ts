import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkAllUpdates, registerAppUpdateCheck, refreshCliUpdateView, synchronizeConnectedClis } from './update-hub-client';

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

describe('explicit app and CLI update checks', () => {
  it('checks both sources once for simultaneous clicks without running an installer', async () => {
    const app = vi.fn(async () => ({ version: null }));
    const unregister = registerAppUpdateCheck(app);
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(report()));
    try {
      expect(await Promise.all([checkAllUpdates(), checkAllUpdates()])).toEqual([
        { hasUpdates: false, incomplete: false }, { hasUpdates: false, incomplete: false },
      ]);
      expect(app).toHaveBeenCalledOnce(); expect(fetch).toHaveBeenCalledOnce();
      expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe('/api/setup/cli-updates?refresh=1');
      expect(vi.mocked(fetch).mock.calls.every(([, options]) => !options?.method)).toBe(true);
    } finally { unregister(); }
  });
  it.each(['app', 'cli'])('reports an available %s update', async source => {
    const unregister = registerAppUpdateCheck(async () => ({ version: source === 'app' ? '0.1.902' : null }));
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(report(source === 'cli' ? 'update-available' : 'current')));
    try { expect(await checkAllUpdates()).toEqual({ hasUpdates: true, incomplete: false }); }
    finally { unregister(); }
  });
  it.each(['unknown', 'failed', 'missing'])('does not report all current when a CLI check is %s', async state => {
    const unregister = registerAppUpdateCheck(async () => ({ version: null }));
    vi.mocked(fetch).mockResolvedValueOnce(state === 'failed' ? new Response(null, { status: 503 })
      : Response.json(state === 'missing' ? { tools: [] } : report('unknown')));
    try { expect((await checkAllUpdates()).incomplete).toBe(true); }
    finally { unregister(); }
  });
  it('retains the latest checker when an earlier owner unmounts and marks app errors incomplete', async () => {
    const old = registerAppUpdateCheck(async () => ({ version: '0.1.900' }));
    const current = registerAppUpdateCheck(async () => { throw new Error('unavailable'); });
    old(); vi.mocked(fetch).mockResolvedValueOnce(Response.json(report()));
    expect(await checkAllUpdates()).toEqual({ hasUpdates: false, incomplete: true });
    current(); vi.mocked(fetch).mockResolvedValueOnce(Response.json(report()));
    expect((await checkAllUpdates()).incomplete).toBe(true);
  });
  it('ignores uninstalled tools and the retired CLI when deciding whether updates are ready', async () => {
    const unregister = registerAppUpdateCheck(async () => ({ version: null }));
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ tools: [...report().tools, record('gemini', 'update-available')] }));
    try { expect(await checkAllUpdates()).toEqual({ hasUpdates: false, incomplete: false }); }
    finally { unregister(); }
  });
});
