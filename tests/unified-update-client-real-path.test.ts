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
  it('verifies connected CLI updates before downloading o8, then retains the final restart gate', async () => {
    expect(await installUpdateAndRestart()).toMatchObject({ installed: true, restartDeferred: false });
    expect(fixture.calls).toEqual(['release-health', 'cli-check', 'cli-update', 'cli-check', 'app-download', 'lease-drain', 'restart']);
  });
  it.each(['failInstall', 'failFinal'] as const)('defers app download and restart when %s prevents synchronization', async key => {
    fixture[key] = true; await expect(installUpdateAndRestart()).rejects.toThrow();
    expect(fixture.download).not.toHaveBeenCalled(); expect(fixture.restart).not.toHaveBeenCalled();
  });
  it('checks connected current CLIs without reinstalling them', async () => {
    fixture.outdated = false; await installUpdateAndRestart();
    expect(fixture.calls).not.toContain('cli-update'); expect(fixture.download).toHaveBeenCalledOnce();
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
