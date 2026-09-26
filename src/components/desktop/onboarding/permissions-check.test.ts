// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), restart: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@/lib/app-update/client-restart', () => ({ relaunchInstalledUpdate: mocks.restart }));
import { hasPermissionsResume, readOnboardingPermissions, restartOnboardingAtPermissions } from './permissions-check';
import { emptyProgress, readProgress } from './onboarding-progress';
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); localStorage.clear(); delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__; });

it('keeps native read failures unknown rather than granting or denying them', async () => {
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === 'mic_permission_granted_cmd') return null;
    if (command === 'accessibility_permission_granted_cmd') throw new Error('IPC unavailable');
    return command === 'input_monitoring_granted_cmd';
  });
  expect(await readOnboardingPermissions()).toEqual({ microphone: 'not-asked', accessibility: 'unknown', 'input-monitoring': 'granted', 'screen-recording': 'denied' });
});
it('persists the same project and permission step before asking the app to restart', async () => {
  const project = { id: 'project', name: 'Project', localPath: '/project' };
  mocks.restart.mockImplementation(async () => {
    expect(readProgress(localStorage)).toMatchObject({ step: 'permissions', project });
    expect(hasPermissionsResume(localStorage)).toBe(true);
  });
  await restartOnboardingAtPermissions(localStorage, { ...emptyProgress(), project });
  expect(mocks.restart).toHaveBeenCalledOnce();
});
it('refuses to restart if persistence fails and preserves the return point when restart fails', async () => {
  await expect(restartOnboardingAtPermissions({ getItem: () => null, setItem: () => { throw new Error('Full'); }, removeItem: () => {} }, emptyProgress())).rejects.toThrow('could not be saved');
  expect(mocks.restart).not.toHaveBeenCalled();
  mocks.restart.mockRejectedValueOnce(new Error('Restart unavailable'));
  await expect(restartOnboardingAtPermissions(localStorage, emptyProgress())).rejects.toThrow('Restart unavailable');
  expect(hasPermissionsResume(localStorage)).toBe(true);
});
