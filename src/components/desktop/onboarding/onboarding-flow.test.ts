// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Onboarding } from '../Onboarding';
import { createOnboardingPreviewRequest, PREVIEW_PROJECT } from '@/app/preview/first-run/FirstRunPreview';
import { PROGRESS_KEY, emptyProgress } from './onboarding-progress';
import { recommendRuntimeSetup } from '@/lib/setup/runtime-recommendation';
import type { OnboardingRequest } from './request';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ''; localStorage.clear(); });
const button = (label: string) => Array.from(document.querySelectorAll('button')).find((item) => item.textContent === label || item.getAttribute('aria-label') === label)!;
const click = async (label: string) => { expect(button(label), label).toBeDefined(); await act(async () => button(label).click()); };
async function render(request: OnboardingRequest = createOnboardingPreviewRequest(), complete = vi.fn().mockResolvedValue(true), pickFolder?: () => Promise<string | null>) {
  const container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(async () => root.render(createElement(Onboarding, { request, onComplete: complete, storage: localStorage, pickFolder })));
  return { container, complete };
}

it('starts with projects and a quiet runtime recommendation without changing settings', async () => {
  const request = vi.fn(createOnboardingPreviewRequest());
  const { container } = await render(request);
  expect(container.textContent).toContain('Open a project');
  expect(container.textContent).toContain('Using Codex');
  expect(button('Open Sample project')).toBeDefined();
  expect(container.querySelector('textarea')).toBeNull();
  expect(container.querySelector('nav[aria-label="Setup progress"]')).toBeNull();
  expect(container.textContent).not.toContain('Workers:');
  expect(request.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});

it('uses an opaque overlay and visible button ink even when workspace glass is transparent', async () => {
  const { container } = await render();
  expect((container.firstElementChild as HTMLElement).style.background).toBe('var(--t-onboarding-bg)');
  expect(button('Open a folder').style.color).toBe('var(--t-onboarding-bg)');
  const { PALETTES } = await import('@/lib/theme/registry');
  for (const palette of PALETTES) {
    expect(palette.baseTokens['--t-onboarding-bg']).toMatch(/^#[0-9a-f]{6}$/i);
  }
});

it('opens the chosen project after explicit privacy choices, without a tour or task draft', async () => {
  const request = vi.fn(createOnboardingPreviewRequest());
  const { complete } = await render(request);
  await click('Open Sample project');
  expect(button('Save both choices').disabled).toBe(true);
  expect(complete).not.toHaveBeenCalled();
  await click('Keep crash reports off');
  expect(button('Save both choices').disabled).toBe(true);
  await click('Keep product usage off');
  await click('Save both choices');
  expect(complete).toHaveBeenCalledWith({ project: PREVIEW_PROJECT, text: '' });
  expect(localStorage.getItem(PROGRESS_KEY)).toBeNull();
  const writes = request.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(writes.map(([, init]) => JSON.parse(String(init?.body)))).toContainEqual({ crashReportsEnabled: false, productTelemetryEnabled: false, telemetryConsentAnswered: true });
});

it('resumes privacy with the selected project and retries a failed workspace handoff', async () => {
  localStorage.setItem(PROGRESS_KEY, JSON.stringify({ ...emptyProgress('privacy'), project: PREVIEW_PROJECT }));
  const complete = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  await render(createOnboardingPreviewRequest(), complete);
  await click('Keep crash reports off');
  await click('Share product usage');
  await click('Save both choices');
  expect(document.body.textContent).toContain('Could not open the workspace');
  expect(localStorage.getItem(PROGRESS_KEY)).not.toBeNull();
  await click('Save both choices');
  expect(complete).toHaveBeenCalledTimes(2);
  expect(localStorage.getItem(PROGRESS_KEY)).toBeNull();
});

it('routes a project to tool setup when no runtime is usable', async () => {
  const fixture = createOnboardingPreviewRequest();
  const request: OnboardingRequest = async (url, init) => String(url).includes('operator-defaults')
    ? Response.json({ values: {}, sources: {}, dispatchableRuntimes: [], setupRecommendation: recommendRuntimeSetup({ inventory: [], activity: { codex: 0, claude: 0, complete: true } }) })
    : fixture(url, init);
  const { complete } = await render(request);
  await click('Open Sample project');
  expect(document.body.textContent).toContain('Connect a coding tool');
  expect(button('Use this setup').disabled).toBe(true);
  expect(complete).not.toHaveBeenCalled();
});

it('revalidates a project before handing it to the workspace', async () => {
  const fixture = createOnboardingPreviewRequest();
  let repoReads = 0;
  const request: OnboardingRequest = async (url, init) => String(url) === '/api/panel/repos' && ++repoReads > 1
    ? Response.json({ repos: [] }) : fixture(url, init);
  const { complete } = await render(request);
  await click('Open Sample project');
  expect(document.body.textContent).toContain('no longer available');
  expect(complete).not.toHaveBeenCalled();
});

it('hydrates legacy progress into the project entry without a markup mismatch', async () => {
  const { renderToString } = await import('react-dom/server');
  const { hydrateRoot } = await import('react-dom/client');
  localStorage.setItem(PROGRESS_KEY, JSON.stringify({ ...emptyProgress(), step: 'ready', project: PREVIEW_PROJECT }));
  const props = { request: createOnboardingPreviewRequest(), onComplete: vi.fn(), storage: localStorage };
  const container = document.createElement('div'); document.body.appendChild(container);
  container.innerHTML = renderToString(createElement(Onboarding, props));
  const onRecoverableError = vi.fn();
  await act(async () => { root = hydrateRoot(container, createElement(Onboarding, props), { onRecoverableError }); });
  expect(onRecoverableError).not.toHaveBeenCalled();
  expect(container.textContent).toContain('Open a project');
  expect(container.textContent).not.toContain('Your first task');
});

it('keeps saved routing and consent, and prevents duplicate workspace openings', async () => {
  const fixture = createOnboardingPreviewRequest(localStorage);
  await fixture('/api/panel/operator-defaults', { method: 'POST', body: JSON.stringify({
    orchestratorBackend: 'claude', workerRuntimes: ['claude-code'], defaultDispatchRuntime: 'claude-code',
    telemetryConsentAnswered: true, crashReportsEnabled: false, productTelemetryEnabled: false,
  }) });
  const request = vi.fn(fixture);
  let finish!: (value: boolean) => void;
  const complete = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
  await render(request, complete);
  expect(document.body.textContent).toContain('Using Claude Code');
  await click('Open Sample project');
  expect(button('Open Sample project').disabled).toBe(true);
  await click('Open Sample project');
  expect(complete).toHaveBeenCalledOnce();
  expect(request.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  await act(async () => finish(true));
  expect(localStorage.getItem(PROGRESS_KEY)).toBeNull();
});

it('returns from optional tool settings without starting work', async () => {
  const { complete } = await render();
  const content = document.querySelector<HTMLElement>('[aria-label="Setup content"]');
  expect(content).not.toBeNull();
  content!.scrollTop = 240;
  await click('Change');
  expect(document.body.textContent).toContain('Your setup');
  expect(content!.scrollTop).toBe(0);
  expect(document.activeElement?.tagName).toBe('H1');
  await click('Use this setup');
  expect(document.body.textContent).toContain('Open a project');
  expect(document.body.textContent).toContain('Using Codex');
  expect(complete).not.toHaveBeenCalled();
});


it('lets folder selection cancel, then registers and opens the chosen project', async () => {
  const request = vi.fn(createOnboardingPreviewRequest());
  const pickFolder = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(PREVIEW_PROJECT.localPath);
  const complete = vi.fn().mockResolvedValue(true);
  await render(request, complete, pickFolder);
  await click('Open a folder');
  expect(request.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  expect(document.body.textContent).toContain('Open a project');
  await click('Open a folder');
  const registration = request.mock.calls.find(([url, init]) => String(url) === '/api/panel/repos' && init?.method === 'POST');
  expect(JSON.parse(String(registration?.[1]?.body))).toEqual({ action: 'add', localPath: PREVIEW_PROJECT.localPath });
  expect(button('Save both choices').disabled).toBe(true);
  expect(complete).not.toHaveBeenCalled();
});
