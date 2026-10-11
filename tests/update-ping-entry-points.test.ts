import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke, check } = vi.hoisted(() => ({
  invoke: vi.fn(async () => null),
  check: vi.fn(async () => null),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/plugin-updater', () => ({ check }));
vi.mock('@/lib/tauri/bridge', () => ({ isTauri: () => true }));

const { installUpdateAndRestart } = await import('@/lib/app-update/client-restart');

describe('desktop update ping entry points', () => {
  beforeEach(() => {
    invoke.mockClear();
    check.mockClear();
  });

  it('checks through the native ping command when installing an update', async () => {
    await expect(installUpdateAndRestart()).resolves.toEqual({ installed: false });
    expect(invoke.mock.calls).toEqual([['check_app_update']]);
    expect(check).not.toHaveBeenCalled();
  });

  it('keeps the service first and the signed GitHub manifest as fallback', () => {
    const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
    expect(config.plugins.updater.endpoints).toEqual([
      'https://api.o8.run/v1/update/{{target}}/{{arch}}/{{current_version}}',
      'https://github.com/hurttlocker/o8-releases/releases/latest/download/latest.json',
    ]);
  });
});
