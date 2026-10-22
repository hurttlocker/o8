// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ mutations: [] as Array<Record<string, unknown>>, unsafeExit: vi.fn(),
  guardedInstall: vi.fn(), lateWork: undefined as (() => void) | undefined, busy: false, consent: false }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: async (input: { mutation: Record<string, unknown> }) => {
  fixture.mutations.push(input.mutation); return true;
} }));
vi.mock('@/lib/app-update/idle-window', () => ({ getUpdateIdleWindow: async () => ({ idle: !fixture.busy, idleExceptParked: !fixture.busy,
  parkedLanes: [], unavailable: [], active: { lanes: [], terminalSessions: fixture.busy ? [{ name: 'late-work' }] : [], ownedSessions: [], managedRuns: [], cloudJobs: [] } }) }));
vi.mock('@/components/shared/ConfirmToastHost', () => ({ requestConfirm: vi.fn(async () => fixture.consent) }));
vi.mock('@/lib/tauri/bridge', () => ({ isTauri: () => true, canUseTauriEvents: () => true }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
vi.mock('@/lib/app-update/check', () => ({ check: async () => ({ rid: 7, version: '0.2.0', installExits: true,
  downloadAndInstall: async () => { fixture.lateWork?.(); fixture.unsafeExit(); throw new Error('unguarded Windows exit'); } }) }));
vi.mock('@tauri-apps/api/core', () => ({ Channel: class { onmessage?: (event: unknown) => void },
  invoke: async (command: string, args?: { force?: boolean }) => {
    if (command === 'get_running_bundle_integrity') return null;
    if (command === 'download_app_update') { fixture.lateWork?.(); return 23; }
    if (command === 'discard_app_update_download') return;
    if (command !== 'install_app_update') throw new Error(`Unexpected command ${command}`);
    fixture.guardedInstall(args?.force);
    const { inspectCliOperationAdmission } = await import('@/lib/setup/cli-operation-admission');
    const { listWorkLaunches } = await import('@/lib/app-update/work-launch-admission');
    if (inspectCliOperationAdmission().blocked || listWorkLaunches().length) throw new Error('cli_operation_blocked: late work');
    throw new Error('Expected persisted late work');
  } }));
const apply = await import('@/app/api/panel/update/apply/route');
const state = await import('@/app/api/panel/app/update-state/route');
const { setAppUpdateState } = await import('@/lib/app-update/relaunch-state');
const { handleUpdateApply } = await import('@/lib/mcp/operator-handlers/update');
const { reserveWorkLaunch } = await import('@/lib/app-update/work-launch-admission');
const { reserveCliInstaller } = await import('@/lib/setup/cli-operation-admission');
const { UpdateCard } = await import('@/components/desktop/UpdateCard');
let host: HTMLDivElement; let root: Root;
let release: (() => void) | undefined;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const request = () => new Request('http://localhost/api/panel/update/apply', { method: 'POST', body: JSON.stringify({ force: true }) });

beforeEach(async () => {
  fixture.mutations = []; fixture.busy = false; fixture.consent = false; fixture.lateWork = undefined;
  vi.clearAllMocks(); window.localStorage.clear();
  setAppUpdateState({ updatePending: true, version: '0.2.0' });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost'); const req = new Request(url, init);
    if (url.pathname === '/api/panel/update/apply') return req.method === 'POST' ? apply.POST(req) : apply.GET();
    if (url.pathname === '/api/panel/app/update-state') return req.method === 'POST' ? state.POST(req) : state.GET();
    if (url.pathname === '/api/panel/release-health') return Response.json({ pulled: false });
    return Response.json({});
  }));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(createElement(UpdateCard, { quiet: true })));
});

it.each([false, true])('checks fresh explicit Windows interruption consent after download (%s)', async consent => {
  fixture.consent = consent;
  fixture.lateWork = () => { fixture.busy = true; release = reserveWorkLaunch('late explicit work').release; };
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await act(async () => window.dispatchEvent(new Event('o8:restart-app-update')));
    const { requestConfirm } = await import('@/components/shared/ConfirmToastHost');
    await vi.waitFor(() => expect(requestConfirm).toHaveBeenCalledOnce());
    await vi.waitFor(async () => {
      const payload = await (await state.GET()).json();
      if (consent) expect(payload.state.lastInstall?.outcome).toBe('failed');
      else expect(payload.state.lastInstall).toBeNull();
    });
    if (consent) expect(fixture.guardedInstall).toHaveBeenCalledWith(true);
    else expect(fixture.guardedInstall).not.toHaveBeenCalled();
    expect(fixture.unsafeExit).not.toHaveBeenCalled();
  } finally { errors.mockRestore(); }
});
afterEach(async () => { release?.(); release = undefined; await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it.each(['webview', 'API', 'MCP'] as const)('%s install reaches native admission before a Windows installer may exit', async entry => {
  fixture.lateWork = () => {
    const lease = entry === 'MCP' ? reserveCliInstaller('fixture') : reserveWorkLaunch(`late ${entry} worker`);
    release = () => lease.release();
  };
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    if (entry === 'API') expect((await apply.POST(request())).status).toBe(202);
    if (entry === 'MCP') expect((await handleUpdateApply({ force: true })).isError).toBe(false);
    await act(async () => {
      if (entry === 'webview') window.dispatchEvent(new Event('o8:install-app-update'));
      else window.dispatchEvent(new CustomEvent('o8:realtime', { detail: { channel: 'realtime', event: 'batch',
        data: { events: [{ data: { mutation: fixture.mutations.at(-1) } }] } } }));
    });
    await vi.waitFor(async () => {
      const payload = await (await state.GET()).json();
      expect(payload.state.lastInstall?.outcome).toBe('failed');
    });
    expect(fixture.guardedInstall).toHaveBeenCalledOnce();
    expect(fixture.unsafeExit).not.toHaveBeenCalled();
  } finally { errorLog.mockRestore(); }
});
