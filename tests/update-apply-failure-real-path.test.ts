// @vitest-environment jsdom
/**
 * #3588: a remote apply that fails in the webview reports why. The real apply
 * route queues its realtime mutation; the real update card runs the install,
 * which the updater rejects; the failure reaches the server update state that
 * the apply route returns, the navigation rail's quiet card and the console.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const seams = vi.hoisted(() => ({
  published: [] as Array<{ mutation: Record<string, unknown> }>,
  installError: 'Failed to verify the update signature' as unknown,
}));
vi.mock('@/lib/realtime/publisher', () => ({
  publishRealtimeMutation: vi.fn(async (request: { mutation: Record<string, unknown> }) => {
    seams.published.push(request);
    return true;
  }),
  requestRealtimeRefresh: vi.fn(async () => true),
}));
vi.mock('@/lib/app-update/idle-window', () => ({
  getUpdateIdleWindow: async () => ({ idle: true, active: { lanes: [], terminalSessions: [], managedRuns: [], ownedSessions: [], cloudJobs: [] },
    unavailable: [], checkedAt: new Date().toISOString() }),
}));
// The desktop shell: a main window that can check, whose updater rejects the install.
vi.mock('@/lib/tauri/bridge', () => ({ isTauri: () => false, canUseTauriEvents: () => true }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
vi.mock('@/lib/app-update/check', () => ({ check: async () => ({ version: '0.1.999', body: null, date: null }) }));
vi.mock('@/lib/app-update/client-restart', () => ({
  RELEASE_URL: 'https://example.test/releases',
  relaunchInstalledUpdate: vi.fn(async () => true),
  installUpdateAndRestart: vi.fn(async () => { throw seams.installError; }),
}));
vi.mock('@/lib/app-update/update-hub-client', () => ({
  publishAppUpdateView: () => {}, refreshCliUpdateView: async () => {}, registerAppUpdateCheck: () => () => {},
}));

import * as applyRoute from '@/app/api/panel/update/apply/route';
import * as stateRoute from '@/app/api/panel/app/update-state/route';
import { UpdateCard } from '@/components/desktop/UpdateCard';

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;

/** The webview's fetch, served by the real routes. */
async function serve(input: RequestInfo | URL, init?: RequestInit) {
  const url = new URL(String(input), 'http://127.0.0.1');
  const request = new Request(url, init);
  if (url.pathname === '/api/panel/app/update-state') return request.method === 'POST' ? stateRoute.POST(request) : stateRoute.GET();
  if (url.pathname === '/api/panel/update/apply') return request.method === 'POST' ? applyRoute.POST(request) : applyRoute.GET();
  return new Response('{}', { status: 404 });
}

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, label: string) {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  }
}

async function applyState() {
  const payload = (await (await applyRoute.GET()).json()) as { state?: { lastInstall?: null | { outcome: string; version: string | null; error: string | null } } };
  return { state: { lastInstall: payload.state?.lastInstall ?? null } };
}

let host: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  seams.published.length = 0;
  vi.stubGlobal('fetch', vi.fn(serve));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  // The navigation rail renders the quiet card.
  await act(async () => root.render(createElement(UpdateCard, { quiet: true })));
  await waitFor(async () => ((await (await stateRoute.GET()).json()).state.updatePending ? true : undefined), 'the check to reach the server');
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function remoteApply() {
  const response = await applyRoute.POST(new Request('http://127.0.0.1/api/panel/update/apply', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ force: true }),
  }));
  expect(response.status).toBe(202);
  const { mutation } = seams.published.at(-1)!;
  // As the desktop WebSocket bridge hands a realtime batch to the window.
  await act(async () => {
    window.dispatchEvent(new CustomEvent('o8:realtime', { detail: { channel: 'realtime', event: 'batch', data: { events: [{ data: { mutation } }] } } }));
  });
}

describe('a failed remote update apply reports why (#3588)', () => {
  it('records the updater message in the apply state, shows it in the rail and logs it', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await remoteApply();
    const failed = await waitFor(async () => {
      const install = (await applyState()).state.lastInstall;
      return install?.outcome === 'failed' ? install : undefined;
    }, 'the failed install to reach the server');
    expect(failed).toMatchObject({ version: '0.1.999', error: 'Failed to verify the update signature' });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Update failed before restart. Failed to verify the update signature');
    expect(errors.mock.calls.some(([first]) => String(first).includes('Failed to verify the update signature'))).toBe(true);
    errors.mockRestore();
  });

  it('keeps a message when the updater rejects with an empty error', async () => {
    seams.installError = new Error('');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await remoteApply();
    // The error's name stands in for its empty message.
    await waitFor(async () => ((await applyState()).state.lastInstall?.error === 'Error' ? true : undefined),
      'the empty-message failure to reach the server');
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Update failed before restart. Error');
  });
});
