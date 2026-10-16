import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ hasUpdate: true, pulled: false, outdated: true, failInstall: false, failFinal: false,
  calls: [] as string[], download: vi.fn(), restart: vi.fn(), open: vi.fn() }));
vi.mock('@/lib/tauri/bridge', () => ({ isTauri: () => true }));
vi.mock('@/lib/desktop/open-external', () => ({ openExternalUrl: fixture.open }));
vi.mock('@/lib/app-update/check', () => ({ check: async () => fixture.hasUpdate ? {
  version: '0.1.902', downloadAndInstall: async () => { fixture.calls.push('app-download'); fixture.download(); },
} : null }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: async () => { fixture.calls.push('restart'); fixture.restart(); } }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: fixture.restart }));
const { installUpdateAndRestart } = await import('@/lib/app-update/client-restart');
beforeEach(() => {
  fixture.hasUpdate = true; fixture.pulled = false; fixture.outdated = true; fixture.failInstall = false; fixture.failFinal = false;
  fixture.calls = []; vi.clearAllMocks(); let reports = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, options?: RequestInit) => {
    if (String(url).startsWith('/api/panel/release-health')) { fixture.calls.push('release-health'); return Response.json({ pulled: fixture.pulled }); }
    if (String(url).startsWith('/api/setup/cli-updates')) {
      if (options?.method === 'POST') { fixture.calls.push('cli-update'); return Response.json(fixture.failInstall ? { error: 'Wait for active sessions.' } : { status: 'succeeded' }, { status: fixture.failInstall ? 409 : 200 }); }
      reports += 1; fixture.calls.push('cli-check');
      if (fixture.failFinal && reports > 1) return new Response(null, { status: 503 });
      return Response.json({ tools: [{ runtimeId: 'codex', label: 'Codex', status: reports === 1 && fixture.outdated ? 'update-available' : 'current' },
        { runtimeId: 'claude-code', label: 'Claude Code', status: 'not-installed' }, { runtimeId: 'grok', label: 'Grok Build', status: 'not-installed' }] });
    }
    if (String(url) === '/api/panel/cloud-jobs/drain') { fixture.calls.push('lease-drain'); return Response.json({}); }
    throw new Error('Unexpected request');
  }));
});
describe('unified updates through the existing app install entry point', () => {
  it('installs only o8 without checking or modifying connected CLIs', async () => {
    expect(await installUpdateAndRestart()).toMatchObject({ installed: true, restartDeferred: false });
    expect(fixture.calls).toEqual(['release-health', 'app-download', 'lease-drain', 'restart']);
  });
  it.each(['failInstall', 'failFinal'] as const)('does not let a CLI failure block the app (%s)', async key => {
    fixture[key] = true;
    expect(await installUpdateAndRestart()).toMatchObject({ installed: true });
    expect(fixture.calls).not.toContain('cli-check');
  });
  it('retains the final idle gate after download', async () => {
    expect(await installUpdateAndRestart(undefined, { beforeRestart: async () => false }))
      .toEqual({ installed: true, restartDeferred: true });
    expect(fixture.calls).toEqual(['release-health', 'app-download']);
  });
  it('waits for an already running CLI update before the final idle check and restart', async () => {
    const { synchronizeConnectedClis } = await import('@/lib/app-update/update-hub-client');
    const original = vi.mocked(fetch).getMockImplementation()!;
    let finish!: (value: Response) => void;
    let started!: () => void;
    const postStarted = new Promise<void>(resolve => { started = resolve; });
    vi.mocked(fetch).mockImplementation(async (url, options) => {
      if (String(url) === '/api/setup/cli-updates' && options?.method === 'POST') {
        started(); return new Promise<Response>(resolve => { finish = resolve; });
      }
      return original(url, options);
    });
    const cli = synchronizeConnectedClis();
    await postStarted;
    const idle = vi.fn(async () => true);
    const app = installUpdateAndRestart(undefined, { beforeRestart: idle });
    await vi.waitFor(() => expect(fixture.download).toHaveBeenCalledOnce());
    expect(idle).not.toHaveBeenCalled(); expect(fixture.restart).not.toHaveBeenCalled();
    finish(Response.json({ status: 'succeeded' }));
    await cli; await app;
    expect(idle).toHaveBeenCalledOnce(); expect(fixture.restart).toHaveBeenCalledOnce();
  });
  it.each(['hasUpdate', 'pulled'])('does not touch CLIs when the app update is absent or pulled (%s)', async key => {
    if (key === 'hasUpdate') fixture.hasUpdate = false; else fixture.pulled = true;
    expect(await installUpdateAndRestart()).toMatchObject({ installed: false });
    expect(fixture.calls).not.toContain('cli-check'); expect(fixture.download).not.toHaveBeenCalled();
  });
  it('retains download-only installation behavior and does not silently install CLIs', async () => {
    expect(await installUpdateAndRestart(undefined, { selfUpdatable: false })).toEqual({ installed: false, downloadOpened: true });
    expect(fixture.open).toHaveBeenCalledOnce(); expect(fixture.calls).toHaveLength(0);
  });
});
