export const ONBOARDING_STEPS = ['open', 'repos', 'dispatch', 'privacy'] as const;
export type OnboardingStep = typeof ONBOARDING_STEPS[number];
export interface OnboardingProject { id: string; name: string; localPath: string; defaultBranch?: string; remoteUrl?: string }
export interface OnboardingTask { project: OnboardingProject; text: string }
export interface OnboardingProgress {
  step: OnboardingStep;
  project: OnboardingProject | null;
  toolsConfigured: boolean;
  task: string;
}
export type ProgressStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export const PROGRESS_KEY = 'o8:onboarding-progress:v1';
export const EXPLAIN_PROJECT = 'Explain this project: what it does, how it is organized, how to run it, and where I should start. Read the project instructions first. Do not change files.';
export const PLAN_CHANGE = 'Help me plan a change to this project. Read the project instructions and structure, then ask me what I want to build before making changes.';
export function emptyProgress(step: OnboardingStep = 'open'): OnboardingProgress {
  return { step, project: null, toolsConfigured: false, task: '' };
}
export function isOnboardingProject(value: unknown): value is OnboardingProject {
  if (!value || typeof value !== 'object') return false;
  const p = value as Partial<OnboardingProject>;
  return typeof p.id === 'string' && Boolean(p.id) && typeof p.name === 'string'
    && typeof p.localPath === 'string' && Boolean(p.localPath);
}
export function readProgress(storage: ProgressStorage | null): OnboardingProgress {
  try {
    const value = JSON.parse(storage?.getItem(PROGRESS_KEY) ?? 'null') as Partial<OnboardingProgress> | null;
    if ((value as { step?: string } | null)?.step === 'ready') value!.step = 'open';
    if (!value || !ONBOARDING_STEPS.includes(value.step as OnboardingStep)) return emptyProgress();
    return { step: value.step as OnboardingStep, project: isOnboardingProject(value.project) ? value.project : null,
      toolsConfigured: value.toolsConfigured === true, task: typeof value.task === 'string' && value.task !== EXPLAIN_PROJECT && value.task !== PLAN_CHANGE ? value.task.slice(0, 12000) : '' };
  } catch { return emptyProgress(); }
}
export function browserProgressStorage(): ProgressStorage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
}
export function writeProgress(storage: ProgressStorage | null, progress: OnboardingProgress): boolean {
  try { if (!storage) return false; storage.setItem(PROGRESS_KEY, JSON.stringify(progress)); return true; } catch { return false; }
}
