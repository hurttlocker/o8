// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Onboarding } from '../Onboarding';
import { previewOnboardingRequest } from '@/app/preview/first-run/FirstRunPreview';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ''; localStorage.clear(); });
it('shows honest blockers at the first-task entry and keeps privacy before workspace entry', async () => {
  const container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(async () => { root.render(createElement(Onboarding, { initialStep: 'ready', request: previewOnboardingRequest, onComplete: vi.fn() })); });
  expect(container.textContent).toContain('Your first task');
  expect(container.textContent).toContain('Choose a project');
  expect(container.textContent).not.toContain('Ready to go');
  expect(container.textContent).not.toContain('Founding Operator');
});

it('persists project, step and task across remounts, keeps choices explicit, and retries completion', async () => {
  const { createOnboardingPreviewRequest, PREVIEW_PROJECT } = await import('@/app/preview/first-run/FirstRunPreview');
  const { PROGRESS_KEY, PLAN_CHANGE } = await import('./onboarding-progress');
  const request = vi.fn(createOnboardingPreviewRequest());
  const complete = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  const render = async (initialStep?: 'repos') => {
    await act(async () => { root.render(createElement(Onboarding, { initialStep, request, onComplete: complete, storage: localStorage })); });
  };
  const button = (label: string) => Array.from(container.querySelectorAll('button')).find((item) => item.textContent === label)!;
  const click = async (label: string) => { expect(button(label), label).toBeDefined(); await act(async () => { button(label).click(); }); };
  await render('repos');
  const projectButton = Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes('Sample project'))!;
  await act(async () => projectButton.click());
  await click('Use this project');
  expect(container.textContent).toContain('Your setup');
  await click('Use this setup');
  expect(button('Save both choices').disabled).toBe(true);
  expect(container.querySelectorAll('details[open]')).toHaveLength(0);
  await click('Keep crash reports off');
  expect(button('Save both choices').disabled).toBe(true);
  await click('Share product usage');
  await click('Save both choices');
  expect(container.textContent).toContain('Your first task');
  await click('Plan a change');
  expect(JSON.parse(localStorage.getItem(PROGRESS_KEY)!).task).toBe(PLAN_CHANGE);
  act(() => root.unmount()); root = createRoot(container);
  await render();
  expect(container.textContent).toContain('Your first task');
  expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe(PLAN_CHANGE);
  expect(button('Open first task').disabled).toBe(false);
  await click('Back');
  expect(button('Keep crash reports off').getAttribute('aria-pressed')).toBe('true');
  expect(button('Share product usage').getAttribute('aria-pressed')).toBe('true');
  await click('Save both choices');
  await click('Open first task');
  expect(complete).toHaveBeenCalledWith({ project: PREVIEW_PROJECT, text: PLAN_CHANGE });
  expect(localStorage.getItem(PROGRESS_KEY)).not.toBeNull();
  await click('Open first task');
  expect(localStorage.getItem(PROGRESS_KEY)).toBeNull();
  expect(request.mock.calls.some(([url]) => String(url).includes('/api/setup/detect'))).toBe(false);
});

it('keeps a missing saved project blocked and offers an explicit setup repair', async () => {
  const { PROGRESS_KEY, emptyProgress } = await import('./onboarding-progress');
  localStorage.setItem(PROGRESS_KEY, JSON.stringify({ ...emptyProgress('ready'), toolsConfigured: true, project: { id: 'removed', name: 'Old project', localPath: '/removed' } }));
  const container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(async () => { root.render(createElement(Onboarding, { request: previewOnboardingRequest, onComplete: vi.fn(), storage: localStorage })); });
  expect(container.textContent).toContain('no longer registered');
  const start = Array.from(container.querySelectorAll('button')).find((item) => item.textContent === 'Open first task')!;
  expect(start.disabled).toBe(true);
});

it('hydrates a saved first task without server/client markup mismatch', async () => {
  const { renderToString } = await import('react-dom/server');
  const { hydrateRoot } = await import('react-dom/client');
  const { PROGRESS_KEY, emptyProgress } = await import('./onboarding-progress');
  localStorage.setItem(PROGRESS_KEY, JSON.stringify(emptyProgress('ready')));
  const props = { request: previewOnboardingRequest, onComplete: vi.fn(), storage: localStorage };
  const container = document.createElement('div'); document.body.appendChild(container);
  container.innerHTML = renderToString(createElement(Onboarding, props));
  expect(container.textContent).toBe('Loading setup…');
  const onRecoverableError = vi.fn();
  await act(async () => { root = hydrateRoot(container, createElement(Onboarding, props), { onRecoverableError }); });
  expect(onRecoverableError).not.toHaveBeenCalled();
  expect(container.textContent).toContain('Your first task');
});
