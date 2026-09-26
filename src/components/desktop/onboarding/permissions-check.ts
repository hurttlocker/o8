import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '@/lib/tauri/bridge';
import { isNonMacShell } from '@/lib/desktop/host-platform';
import { PERMISSIONS, type PermId, type PermStatus } from '@/components/desktop/settings/permissions-model';
import { relaunchInstalledUpdate } from '@/lib/app-update/client-restart';
import { writeProgress, type OnboardingProgress, type ProgressStorage } from './onboarding-progress';

export const PERMISSIONS_RESUME_KEY = 'o8:onboarding-permissions-resume:v1';
export type PermissionSnapshot = Record<PermId, PermStatus>;
export const EMPTY_PERMISSIONS: PermissionSnapshot = { microphone: 'unknown', accessibility: 'unknown', 'input-monitoring': 'unknown', 'screen-recording': 'unknown' };
const commands: Record<PermId, string> = { microphone: 'mic_permission_granted_cmd', accessibility: 'accessibility_permission_granted_cmd', 'input-monitoring': 'input_monitoring_granted_cmd', 'screen-recording': 'screen_capture_granted_cmd' };
export const supportsPermissionCheck = () => isTauri() && !isNonMacShell();

export async function readOnboardingPermissions(): Promise<PermissionSnapshot> {
  if (!supportsPermissionCheck()) return { ...EMPTY_PERMISSIONS };
  const results = await Promise.allSettled(PERMISSIONS.map((item) => invoke<boolean | null>(commands[item.id])));
  return Object.fromEntries(PERMISSIONS.map((item, index) => {
    const result = results[index]!;
    const status: PermStatus = result.status === 'rejected' ? 'unknown' : result.value === true ? 'granted'
      : result.value === false ? 'denied' : item.id === 'microphone' && result.value === null ? 'not-asked' : 'unknown';
    return [item.id, status];
  })) as PermissionSnapshot;
}
export async function requestOnboardingPermission(id: PermId, status: PermStatus): Promise<void> {
  if (!supportsPermissionCheck()) throw new Error('Open o8 on macOS to check these permissions.');
  if (id === 'microphone' && status === 'not-asked') { await invoke('request_mic_access_cmd'); return; }
  if (id === 'input-monitoring' && await invoke<boolean>('request_input_monitoring_cmd')) return;
  await invoke('open_system_settings', { target: PERMISSIONS.find((item) => item.id === id)!.deepLink });
}
export function readPermissionsResume(storage: ProgressStorage | null): string | null {
  try {
    const value = storage?.getItem(PERMISSIONS_RESUME_KEY);
    return value === 'pending' || value?.startsWith('resume:') ? value : null;
  } catch { return null; }
}
export function hasPermissionsResume(storage: ProgressStorage | null): boolean { return readPermissionsResume(storage) !== null; }
export async function restartOnboardingAtPermissions(storage: ProgressStorage | null, progress: OnboardingProgress): Promise<void> {
  if (!storage || !writeProgress(storage, { ...progress, step: 'permissions' })) throw new Error('Your place could not be saved. o8 has not restarted.');
  try { storage.setItem(PERMISSIONS_RESUME_KEY, `resume:${crypto.randomUUID()}`); }
  catch { throw new Error('Your return point could not be saved. o8 has not restarted.'); }
  await relaunchInstalledUpdate();
}
