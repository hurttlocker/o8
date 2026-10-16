// @vitest-environment jsdom

/**
 * #3722: an operator's "Update o8" downloads with visible progress first, then
 * names what the restart waits for. "Restart now" passes tasks that are only
 * waiting for review or input, and nothing else.
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

const { UpdateCard } = await import('./UpdateCard');
const { installUpdateAndRestart, relaunchInstalledUpdate } = await import('@/lib/app-update/client-restart');

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

  it('keeps a restart waiting while work is running, and names that work', async () => {
    idlePayload = withLiveWork;
    vi.mocked(installUpdateAndRestart).mockResolvedValue({ installed: true, restartDeferred: true });
    vi.mocked(relaunchInstalledUpdate).mockImplementation(async (options) => Boolean(await options?.beforeRestart?.()));

    await mount();
    await act(async () => { window.dispatchEvent(new Event('o8:install-app-update')); });
    expect(lastView().message).toBe('Update installed. Restart is waiting for running work to finish.');
    expect(lastView().blockers?.live).toEqual(['Build the release (running)']);

    await act(async () => { window.dispatchEvent(new Event('o8:restart-app-update')); });
    expect(await vi.mocked(relaunchInstalledUpdate).mock.results[0]!.value).toBe(false);
    expect(lastView().blockers?.live).toEqual(['Build the release (running)']);
  });
});
