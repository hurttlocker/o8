// @vitest-environment jsdom

/**
 * #3722: an operator's "Update o8" downloads with visible progress first, then
 * names what the restart waits for. Explicit restart preserves parked tasks,
 * requires consent to interrupt work and cannot bypass CLI installer ownership.
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppUpdateView } from '@/lib/app-update/update-hub-client';
import type { InstallUpdateOptions } from '@/lib/app-update/client-restart';

const views: AppUpdateView[] = [];
vi.mock('@/lib/app-update/update-hub-client', () => ({
  publishAppUpdateView: vi.fn((view: AppUpdateView) => { views.push(view); }),
  refreshCliUpdateView: vi.fn(async () => undefined),
  registerAppUpdateCheck: vi.fn(() => () => undefined),
}));
vi.mock('@/lib/app-update/client-restart', () => ({
  installUpdateAndRestart: vi.fn(),
  relaunchInstalledUpdate: vi.fn(),
  RELEASE_URL: 'https://example.test/releases',
}));
vi.mock('@/lib/tauri/bridge', () => ({ isTauri: () => false, canUseTauriEvents: () => false }));
vi.mock('@/components/shared/ConfirmToastHost', () => ({ requestConfirm: vi.fn(async () => false) }));

const { UpdateCard } = await import('./UpdateCard');
const { installUpdateAndRestart, relaunchInstalledUpdate } = await import('@/lib/app-update/client-restart');
const { requestConfirm } = await import('@/components/shared/ConfirmToastHost');

const parkedOnly = {
  ok: true,
  idle: {
    idle: false,
    idleExceptParked: true,
    parkedLanes: [{ label: 'Fix the login form', status: 'reviewing' }, { label: 'Ask about the schema', status: 'awaiting_input' }],
    unavailable: [],
    active: {
      lanes: [{ label: 'Fix the login form', status: 'reviewing' }, { label: 'Ask about the schema', status: 'awaiting_input' }],
      terminalSessions: [], managedRuns: [], ownedSessions: [], cloudJobs: [],
    },
  },
};
const withLiveWork = {
  ok: true,
  idle: {
    ...parkedOnly.idle,
    idleExceptParked: false,
    active: { ...parkedOnly.idle.active, lanes: [...parkedOnly.idle.active.lanes, { label: 'Build the release', status: 'running' }] },
  },
};

describe('operator update with waiting tasks', () => {
  let root: Root;
  let container: HTMLDivElement;
  let idlePayload: unknown;

  beforeEach(() => {
    views.length = 0;
    idlePayload = parkedOnly;
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => Response.json(String(input).startsWith('/api/panel/update/apply') ? idlePayload : { ok: true })));
    window.localStorage.clear();
    vi.mocked(installUpdateAndRestart).mockReset();
    vi.mocked(relaunchInstalledUpdate).mockReset();
    vi.mocked(requestConfirm).mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const lastView = () => views[views.length - 1]!;
  const mount = async () => {
    await act(async () => root.render(createElement(UpdateCard, { quiet: true })));
    await act(async () => {
      window.dispatchEvent(new CustomEvent('o8:update-found', { detail: { version: '0.1.796', currentVersion: '0.1.795' } }));
    });
  };

  it('shows download progress, then names the waiting tasks, and restarts past them on "Restart now"', async () => {
    let pending: { options: InstallUpdateOptions; resolve: (value: { installed: boolean; restartDeferred: boolean }) => void } | null = null;
    vi.mocked(installUpdateAndRestart).mockImplementation((_url, options) => new Promise(resolve => { pending = { options: options!, resolve }; }));
    vi.mocked(relaunchInstalledUpdate).mockImplementation(async (options) => Boolean(await options?.beforeRestart?.()));

    await mount();
    expect(lastView()).toMatchObject({ version: '0.1.796', currentVersion: '0.1.795' });

    await act(async () => { window.dispatchEvent(new Event('o8:install-app-update')); });
    expect(installUpdateAndRestart).toHaveBeenCalledOnce();
    await act(async () => { pending!.options.onProgress?.({ stage: 'downloading', receivedBytes: 10 * 1_048_576, totalBytes: 40 * 1_048_576 }); });
    expect(lastView()).toMatchObject({ installing: true, progress: { stage: 'downloading', receivedBytes: 10 * 1_048_576, totalBytes: 40 * 1_048_576 } });
    await act(async () => { pending!.options.onProgress?.({ stage: 'installing', receivedBytes: 40 * 1_048_576, totalBytes: 40 * 1_048_576 }); });
    expect(lastView().progress?.stage).toBe('installing');
    await act(async () => {
      // Parked tasks pass the idle gate; simulate a separate native restart deferral.
      expect(await pending!.options.beforeRestart!()).toBe(true);
      pending!.resolve({ installed: true, restartDeferred: true });
    });
    expect(lastView().progress ?? null).toBeNull();
    expect(lastView().message).toBe('Update installed. Restart now to apply it. Waiting tasks keep their state.');
    expect(lastView().blockers).toEqual({
      live: [],
      parked: ['Fix the login form (waiting for review)', 'Ask about the schema (waiting for input)'],
    });

    await act(async () => { window.dispatchEvent(new Event('o8:restart-app-update')); });
    expect(relaunchInstalledUpdate).toHaveBeenCalledOnce();
    expect(await vi.mocked(relaunchInstalledUpdate).mock.results[0]!.value).toBe(true);
  });

  it('keeps a restart waiting when interruption is declined, and names that work', async () => {
    idlePayload = withLiveWork;
    vi.mocked(installUpdateAndRestart).mockResolvedValue({ installed: true, restartDeferred: true });
    vi.mocked(relaunchInstalledUpdate).mockImplementation(async (options) => Boolean(await options?.beforeRestart?.()));

    await mount();
    await act(async () => { window.dispatchEvent(new Event('o8:install-app-update')); });
    expect(lastView().message).toBe('Update installed. Waiting for: Build the release (running).');
    expect(lastView().blockers?.live).toEqual(['Build the release (running)']);

    await act(async () => { window.dispatchEvent(new Event('o8:restart-app-update')); });
    expect(await vi.mocked(relaunchInstalledUpdate).mock.results[0]!.value).toBe(false);
    expect(requestConfirm).toHaveBeenCalledWith(expect.objectContaining({ confirmLabel: 'Restart anyway', cancelLabel: 'Keep waiting', danger: true }));
    expect(lastView().blockers?.live).toEqual(['Build the release (running)']);
  });

  it.each(['active', 'interrupted', 'unconfirmed'])('names a %s CLI installer instead of inventing lane or terminal blockers', async state => {
    idlePayload = { ok: true, idle: { idle: false, idleExceptParked: false, parkedLanes: [], unavailable: [],
      active: { lanes: [], terminalSessions: [], managedRuns: [], ownedSessions: [], cloudJobs: [],
        cliInstallers: [{ runtime: 'codex', state }] } } };
    vi.mocked(installUpdateAndRestart).mockResolvedValue({ installed: true, restartDeferred: true });
    vi.mocked(relaunchInstalledUpdate).mockImplementation(async options => Boolean(await options?.beforeRestart?.()));
    await mount();
    await act(async () => { window.dispatchEvent(new Event('o8:install-app-update')); });
    expect(lastView().message).toContain('CLI update for codex');
    expect(lastView().blockers?.live).toHaveLength(1);
    expect(lastView().blockers?.live[0]).toContain(state === 'active' ? 'is running'
      : state === 'interrupted' ? 'was interrupted' : 'has unconfirmed ownership');
    await act(async () => { window.dispatchEvent(new Event('o8:restart-app-update')); });
    expect(await vi.mocked(relaunchInstalledUpdate).mock.results[0]!.value).toBe(false);
  });


  it('names another reserved restart without calling it an interrupted CLI installer', async () => {
    idlePayload = { ok: true, idle: { idle: false, idleExceptParked: false, parkedLanes: [], unavailable: [],
      active: { lanes: [], terminalSessions: [], managedRuns: [], ownedSessions: [], cloudJobs: [], restartPending: true } } };
    vi.mocked(installUpdateAndRestart).mockResolvedValue({ installed: true, restartDeferred: true });
    await mount();
    await act(async () => { window.dispatchEvent(new Event('o8:install-app-update')); });
    expect(lastView().message).toBe('Update installed. Waiting for: Another app restart is already reserved.');
    expect(lastView().blockers?.live).toEqual(['Another app restart is already reserved']);
  });

  it('passes parked-only remote apply through both webview idle checks', async () => {
    vi.mocked(installUpdateAndRestart).mockResolvedValue({ installed: true });
    await mount();
    const detail = { data: { events: [{ data: { mutation: {
      action: 'app-update-apply-requested', status: 'queued', mutationId: 'parked-remote-apply', force: false,
    } } }] } };
    await act(async () => { window.dispatchEvent(new CustomEvent('o8:realtime', { detail })); });
    expect(installUpdateAndRestart).toHaveBeenCalledOnce();
    const options = vi.mocked(installUpdateAndRestart).mock.calls[0]![1]!;
    expect(await options.beforeRestart?.()).toBe(true);
    expect(requestConfirm).not.toHaveBeenCalled();
  });

  it.each(['network', 'http', 'receipt'])('requires a confirmed manual ownership receipt after a %s failure', async failure => {
    vi.mocked(installUpdateAndRestart).mockResolvedValue({ installed: true });
    await mount();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/app/update-state') && String(init?.body).includes('started')) {
        if (failure === 'network') throw new Error('fixture network failure');
        return Response.json({ ok: false }, { status: failure === 'http' ? 503 : 200 });
      }
      return Response.json({ ok: true });
    }));
    await act(async () => { window.dispatchEvent(new Event('o8:install-app-update')); });
    expect(installUpdateAndRestart).not.toHaveBeenCalled();
    expect(lastView().error).toContain('ownership could not be confirmed');
  });

  it('reads a native staged update and names its blockers before an explicit restart', async () => {
    const activity = { attemptId: 'native-fixture', phase: 'waiting', installed: true, version: '0.1.796',
      blockers: { live: ['Terminal Build terminal'], parked: [] }, error: null };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).includes('/app/update-state')
      ? Response.json({ state: { updatePending: true, version: '0.1.796',
        check: { outcome: 'available', checkedAt: new Date().toISOString(), error: null }, autoApply: activity } })
      : Response.json(withLiveWork)));
    vi.mocked(relaunchInstalledUpdate).mockImplementation(async options => Boolean(await options?.beforeRestart?.()));
    await mount();
    expect(lastView().blockers?.live).toEqual(['Terminal Build terminal']);
    expect(lastView().message).toContain('Terminal Build terminal');
    await act(async () => { window.dispatchEvent(new Event('o8:restart-app-update')); });
    expect(installUpdateAndRestart).not.toHaveBeenCalled();
    expect(requestConfirm).toHaveBeenCalledWith(expect.objectContaining({ confirmLabel: 'Restart anyway' }));
  });

  it('records the actual installed version when a fresh plugin check differs from the displayed version', async () => {
    vi.mocked(installUpdateAndRestart).mockResolvedValue({ installed: true, version: '0.1.797', restartDeferred: true });
    await mount();
    await act(async () => { window.dispatchEvent(new Event('o8:install-app-update')); });
    expect(fetch).toHaveBeenCalledWith('/api/panel/app/update-state', expect.objectContaining({
      body: JSON.stringify({ install: { outcome: 'installed', version: '0.1.797' } }),
    }));
  });

});
