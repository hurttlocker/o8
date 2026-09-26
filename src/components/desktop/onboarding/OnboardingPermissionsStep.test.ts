// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ read: vi.fn(), request: vi.fn() }));
vi.mock('./permissions-check', async (original) => ({ ...await original<typeof import('./permissions-check')>(), supportsPermissionCheck: () => true, readOnboardingPermissions: mocks.read, requestOnboardingPermission: mocks.request }));
import { OnboardingPermissionsStep } from './OnboardingPermissionsStep';
import { PERMISSIONS_RESUME_KEY } from './permissions-check';
let root: Root;
afterEach(() => { act(() => root?.unmount()); document.body.replaceChildren(); localStorage.clear(); vi.useRealTimers(); vi.clearAllMocks(); });
it('rechecks after return and keeps a newly saved restart marker through later polls', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.useFakeTimers();
  mocks.read.mockResolvedValue({ microphone: 'granted', accessibility: 'granted', 'input-monitoring': 'unknown', 'screen-recording': 'denied' });
  localStorage.setItem(PERMISSIONS_RESUME_KEY, 'pending');
  const host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  const restart = vi.fn(async () => { localStorage.setItem(PERMISSIONS_RESUME_KEY, 'pending'); });
  await act(async () => root.render(createElement(OnboardingPermissionsStep, { storage: localStorage, onRestart: restart, onContinue: vi.fn(), onBusyChange: vi.fn() })));
  expect(document.body.textContent).toContain('Back where you left off');
  expect(document.body.textContent).toContain('Not verified');
  expect(document.querySelector('[aria-label="Microphone ready"]')?.textContent).toBe('Ready');
  expect(document.querySelector('[aria-label="Input Monitoring ready"]')).toBeNull();
  expect(document.body.textContent).not.toContain('We can hear you.');
  expect(localStorage.getItem(PERMISSIONS_RESUME_KEY)).toBeNull();
  const button = [...document.querySelectorAll('button')].find((node) => node.textContent === 'Restart and return')!;
  await act(async () => button.click());
  await act(async () => vi.advanceTimersByTime(3000));
  expect(localStorage.getItem(PERMISSIONS_RESUME_KEY)).toBe('pending');
  expect(restart).toHaveBeenCalledOnce();
});

it('does not erase a new return marker when an older permission read finishes late', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let resolveRead!: (value: Record<string, string>) => void;
  mocks.read.mockImplementationOnce(() => new Promise((resolve) => { resolveRead = resolve; }));
  localStorage.setItem(PERMISSIONS_RESUME_KEY, 'resume:old');
  const host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root.render(createElement(OnboardingPermissionsStep, { storage: localStorage, onRestart: async () => { localStorage.setItem(PERMISSIONS_RESUME_KEY, 'resume:new'); }, onContinue: vi.fn(), onBusyChange: vi.fn() })));
  const button = [...document.querySelectorAll('button')].find((node) => node.textContent === 'Restart and return')!;
  await act(async () => button.click());
  await act(async () => resolveRead({ microphone: 'granted', accessibility: 'granted', 'input-monitoring': 'granted', 'screen-recording': 'granted' }));
  expect(localStorage.getItem(PERMISSIONS_RESUME_KEY)).toBe('resume:new');
});
