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
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => Response.json(String(input).startsWith('/api/panel/update/apply') ? idlePayload : {})));
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
      // The strict gate refuses: two tasks are waiting.
      expect(await pending!.options.beforeRestart!()).toBe(false);
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
    expect(lastView().message).toBe('Update installed. Restart is waiting for running work to finish.');
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
    expect(lastView().message).toBe(state === 'active'
      ? 'Update installed. Restart is waiting for CLI updates to finish.'
      : 'Update installed. Restart needs CLI update recovery; check the tool and its update receipt.');
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
    expect(lastView().message).toBe('Update installed. Another restart is already in progress.');
    expect(lastView().blockers?.live).toEqual(['Another app restart is already reserved']);
  });

});
