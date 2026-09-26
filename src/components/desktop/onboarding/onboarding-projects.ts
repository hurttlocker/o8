import { isTauri } from '@/lib/tauri/bridge';
import { requestPrompt } from '@/components/shared/ConfirmToastHost';
import { isOnboardingProject, type OnboardingProject } from './onboarding-progress';
import type { OnboardingRequest } from './request';

export const SOURCE_WEB_FOLDER_ERROR = 'The native o8 shell is required to choose a folder. From this source checkout, run `npm run build:cli` then `node cli/dist/o8.mjs repo add /absolute/path`.';

export async function pickFolderPath(): Promise<string | null> {
  let folderPath: string | null = null;
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const result = await open({ directory: true, title: 'Select project folder' });
    if (typeof result === 'string') folderPath = result;
  } catch {
    // An unavailable chooser needs an immediate local fallback. The server's
    // chooser can run on another machine and cannot distinguish errors from cancel.
    folderPath = await requestPrompt({ title: 'Open folder', message: 'The folder chooser is unavailable. Enter your project folder path.', placeholder: '/path/to/folder' });
  }
  const trimmed = folderPath?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

export async function loadOnboardingProjects(request: OnboardingRequest): Promise<OnboardingProject[]> {
  const response = await request('/api/panel/repos', { cache: 'no-store' });
  if (!response.ok) throw new Error('Could not load your projects. You can still open a folder.');
  const data = await response.json();
  return (Array.isArray(data.repos) ? data.repos : []).filter(isOnboardingProject);
}

export async function chooseOnboardingProject(request: OnboardingRequest, pickFolder?: () => Promise<string | null>): Promise<OnboardingProject | null> {
  if (!pickFolder && !isTauri()) throw new Error(SOURCE_WEB_FOLDER_ERROR);
  const path = await (pickFolder ? pickFolder() : pickFolderPath());
  if (!path?.trim()) return null;
  const response = await request('/api/panel/repos', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'add', localPath: path.trim() }),
  });
  const data = await response.json();
  if (!response.ok || !isOnboardingProject(data.repo)) throw new Error(data.error ?? 'Could not open that folder. Try another project.');
  return data.repo;
}
