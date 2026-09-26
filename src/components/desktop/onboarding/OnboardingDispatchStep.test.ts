// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OnboardingDispatchStep } from './OnboardingDispatchStep';
import { recommendRuntimeSetup, type SetupRuntime } from '@/lib/setup/runtime-recommendation';
import { MODEL_IDS } from '@/lib/models';

let root: Root | null = null;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ''; });
const inventory: SetupRuntime[] = [
  { id: 'codex', label: 'Codex', available: true, unavailableReason: null, detail: 'Ready', fix: '' },
  { id: 'claude-code', label: 'Claude Code', available: true, unavailableReason: null, detail: 'Ready', fix: '' },
  { id: 'gemini', label: 'Gemini', available: false, unavailableReason: 'needs_auth', detail: 'Installed', fix: 'Run gemini to sign in.' },
  { id: 'opencode', label: 'OpenCode', available: false, unavailableReason: 'not_installed', detail: 'Missing', fix: 'Install OpenCode.' },
];
const activity = { codex: 3, claude: 9, complete: true };
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === text)!;

async function render(items = inventory) {
  const payload = { values: {}, sources: {}, dispatchableRuntimes: items, setupRecommendation: recommendRuntimeSetup({ inventory: items, activity }) };
  const request = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(payload)));
  const onContinue = vi.fn();
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(createElement(OnboardingDispatchStep, {
    request, onContinue, onSkip: vi.fn(), renderButton: (props) => createElement('button', { onClick: props.onClick, disabled: props.disabled }, props.label),
  })));
  return { request, onContinue };
}

describe('one recommended runtime setup', () => {
  it('shows one setup, keeps both primary choices, and saves the lead and economical worker model', async () => {
    const { request, onContinue } = await render();
    expect(document.body.textContent).toContain('Claude Code has more local sessions');
    expect(document.body.textContent).toContain('Your setup');
    expect(button('Use this setup').disabled).toBe(false);
    const picker = document.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')!;
    await act(async () => picker.click());
    expect(document.body.querySelector('[role="listbox"]')?.textContent).toContain('Codex');
    expect(document.body.querySelector('[role="listbox"]')?.textContent).toContain('Claude Code');
    await act(async () => button('Use this setup').click());
    const write = request.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(write?.[1]?.body))).toMatchObject({
      orchestratorBackend: 'claude', defaultDispatchRuntime: 'claude-code', workerRuntimes: ['claude-code'],
      defaultDispatchModel: MODEL_IDS.claudeWorkerDefault,
    });
    expect(onContinue).toHaveBeenCalledOnce();
  });

  it('keeps missing tools in Add tools and installed tools needing attention in customization', async () => {
    await render();
    await act(async () => button('Customize').click());
    const workerButtons = [...document.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')];
    expect(workerButtons.some((item) => item.textContent?.includes('Gemini'))).toBe(true);
    expect(workerButtons.find((item) => item.textContent?.includes('Gemini'))?.disabled).toBe(true);
    expect(workerButtons.some((item) => item.textContent?.includes('OpenCode'))).toBe(false);
    expect(document.querySelector('details')?.textContent).toContain('Install OpenCode');
  });

  it('can finish setup after a tool is installed and refreshed', async () => {
    const { request } = await render(inventory.map((item) => ({ ...item, available: false, unavailableReason: 'not_installed' })));
    expect(button('Use this setup').disabled).toBe(true);
    request.mockImplementation(async () => new Response(JSON.stringify({
      values: {}, sources: {}, dispatchableRuntimes: inventory,
      setupRecommendation: recommendRuntimeSetup({ inventory, activity }),
    })));
    await act(async () => button('Refresh tools').click());
    expect(button('Use this setup').disabled).toBe(false);
    expect(document.body.textContent).toContain('Workers: Claude Code');
  });

  it('offers a skippable setup when nothing is ready', async () => {
    await render(inventory.map((item) => ({ ...item, available: false, unavailableReason: 'not_installed' })));
    expect(button('Use this setup').disabled).toBe(true);
    expect(button('Set up later').disabled).toBe(false);
  });
});


it('offers Fable through a ready Claude tool and saves the selected lead', async () => {
  const { request } = await render();
  await act(async () => button('Customize').click());
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')!.click());
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.textContent?.includes('Fable'));
  expect(option).toBeTruthy();
  await act(async () => option!.click());
  await act(async () => button('Keep it simple').click());
  expect(document.querySelector('[aria-haspopup="listbox"]')?.textContent).toContain('Fable');
  await act(async () => button('Use this setup').click());
  const write = request.mock.calls.find(([, init]) => init?.method === 'POST');
  expect(JSON.parse(String(write?.[1]?.body))).toMatchObject({ orchestratorBackend: 'fable', defaultDispatchModel: 'claude-sonnet-5' });
});

it('keeps a failed setup save visible and retryable', async () => {
  const { request, onContinue } = await render();
  request.mockImplementation(async () => new Response(JSON.stringify({ error: 'Could not save settings' }), { status: 503 }));
  await act(async () => button('Use this setup').click());
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not save settings');
  expect(button('Use this setup').disabled).toBe(false);
  expect(onContinue).not.toHaveBeenCalled();
});
