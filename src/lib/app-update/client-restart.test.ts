import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke, relaunch, waitForConnectedCliUpdates } = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: unknown) => Promise<unknown>>(),
  relaunch: vi.fn(async () => undefined),
  waitForConnectedCliUpdates: vi.fn(async () => undefined),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch }));
vi.mock('./update-hub-client', () => ({ waitForConnectedCliUpdates }));
const { relaunchInstalledUpdate } = await import('./client-restart');
afterAll(() => vi.unstubAllGlobals());

describe('relaunchInstalledUpdate', () => {
  beforeEach(() => {
    invoke.mockReset().mockImplementation(async command => command === 'prepare_app_restart' ? 'native-reservation' : undefined);
    relaunch.mockClear();
    waitForConnectedCliUpdates.mockClear();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })));
  });

  it('re-checks the caller safety gate before reserving restart', async () => {
    const beforeRestart = vi.fn(async () => false);
    await expect(relaunchInstalledUpdate({ beforeRestart })).resolves.toBe(false);
    expect(beforeRestart).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(relaunch).not.toHaveBeenCalled();
  });

  it('reserves native admission and commits the same reservation without an early cloud drain', async () => {
    const order: string[] = [];
    invoke.mockImplementation(async command => { order.push(command); return command === 'prepare_app_restart' ? 'native-reservation' : undefined; });
    vi.stubGlobal('fetch', vi.fn(async () => { order.push('drain'); return new Response(); }));
    await expect(relaunchInstalledUpdate({ beforeRestart: async () => true })).resolves.toBe(true);
    expect(order).toEqual(['prepare_app_restart', 'restart_app']);
    expect(fetch).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenLastCalledWith('restart_app', { reservationId: 'native-reservation' });
    expect(relaunch).not.toHaveBeenCalled();
  });

  it('defers on shared installer ownership without draining or bypassing native admission', async () => {
    invoke.mockRejectedValue('cli_operation_blocked: A CLI update is active.');
    await expect(relaunchInstalledUpdate()).resolves.toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(relaunch).not.toHaveBeenCalled();
  });

  it('releases its reservation after a refused commit without using raw relaunch', async () => {
    invoke.mockImplementation(async command => {
      if (command === 'prepare_app_restart') return 'native-reservation';
      if (command === 'restart_app') throw 'cli_operation_blocked: Ownership changed.';
    });
    await expect(relaunchInstalledUpdate()).resolves.toBe(false);
    expect(invoke).toHaveBeenLastCalledWith('cancel_app_restart', { reservationId: 'native-reservation' });
    expect(relaunch).not.toHaveBeenCalled();
  });

  it('surfaces an unavailable native safety command instead of silently bypassing it', async () => {
    invoke.mockRejectedValue(new Error('native command unavailable'));
    await expect(relaunchInstalledUpdate()).rejects.toThrow('native command unavailable');
    expect(fetch).not.toHaveBeenCalled();
    expect(relaunch).not.toHaveBeenCalled();
  });

  it('does not drain or restart when native preparation returns no reservation', async () => {
    invoke.mockResolvedValue(undefined);
    await expect(relaunchInstalledUpdate()).rejects.toThrow('Native restart reservation was not recorded');
    expect(fetch).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(relaunch).not.toHaveBeenCalled();
  });

  it('keeps an idle confirmation unforced so new work is protected by native admission', async () => {
    await relaunchInstalledUpdate({ beforeRestart: async () => true });
    expect(invoke).toHaveBeenCalledWith('prepare_app_restart', { force: false });
  });

  it('reads explicit interruption consent after the final caller check', async () => {
    let confirmed = false;
    const beforeRestart = Object.assign(async () => { confirmed = true; return true; }, { interruptWork: () => confirmed });
    await relaunchInstalledUpdate({ beforeRestart });
    expect(invoke).toHaveBeenCalledWith('prepare_app_restart', { force: true });
  });

});
