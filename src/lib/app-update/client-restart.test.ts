import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke, relaunch } = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined),
  relaunch: vi.fn(async () => undefined),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch }));

const { relaunchInstalledUpdate } = await import('./client-restart');

describe('relaunchInstalledUpdate', () => {
  beforeEach(() => {
    invoke.mockClear();
    relaunch.mockClear();
  });

  it('re-checks the caller safety gate immediately before invoking restart', async () => {
    const beforeRestart = vi.fn(async () => false);
    await expect(relaunchInstalledUpdate({ beforeRestart })).resolves.toBe(false);
    expect(beforeRestart).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalled();
    expect(relaunch).not.toHaveBeenCalled();
  });

  it('invokes the existing restart command after the final gate passes', async () => {
    const beforeRestart = vi.fn(async () => true);
    await expect(relaunchInstalledUpdate({ beforeRestart })).resolves.toBe(true);
    expect(beforeRestart).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith('restart_app');
  });
});
