// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const defaults = vi.hoisted(() => ({ updateField: vi.fn(), builtInReady: true }));
vi.mock('./useModelSettings', () => ({ useModelSettings: () => ({
  data: { dispatchableRuntimes: [{ id: 'pi-builtin', available: defaults.builtInReady, detail: defaults.builtInReady ? 'Bundled and ready' : 'Requires Node 22.19 or newer', fix: 'Update the runtime' }], values: { codexWorkerEffort: 'high', claudeWorkerEffort: 'high', orchestratorModel: 'sonnet' }, sources: {} },
  loading: false, notice: null, busyField: null, updateField: defaults.updateField,
}) }));
vi.mock('./APIKeysTab', () => ({
  ApiKeysProviderList: ({ providerId }: { providerId?: string }) => {
    const [value, setValue] = useState('');
    return createElement('input', { 'aria-label': `${providerId} key`, type: 'password', value, onChange: (event: { target: { value: string } }) => setValue(event.target.value) });
  },
  NativeKeysList: () => createElement('p', null, 'Voice key editor'),
}));
vi.mock('./ModelsTab', () => ({ ModelDefaultsContent: () => createElement('p', null, 'Routing settings') }));
vi.mock('./LocalModelsTab', () => ({ LocalModelsContent: () => createElement('p', null, 'Local model settings') }));
vi.mock('./LocalAcpSection', () => ({ LocalAcpSection: () => createElement('p', null, 'ACP connection settings') }));
vi.mock('./OpenRouterModelsSection', () => ({ OpenRouterModelsSection: () => createElement('p', null, 'OpenRouter model visibility') }));
vi.mock('./ClaudeCodeHarnessSection', () => ({ ClaudeCodeHarnessSection: () => createElement('p', null, 'Claude connection settings') }));
vi.mock('./ChatGPTPlanConnection', () => ({ ChatGPTPlanConnection: () => createElement('p', null, 'ChatGPT plan connection') }));
vi.mock('./CliUpdatePrompt', () => ({ CliUpdatePrompt: () => null }));

import { ProvidersTab } from './ProvidersTab';
import { ProviderUsageSection } from './ProviderUsageSection';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
const request = vi.fn();
const keyProviders = [{ id: 'openrouter', label: 'OpenRouter', configured: true }, { id: 'anthropic', label: 'Anthropic', configured: false }];
beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  defaults.updateField.mockClear();
  defaults.builtInReady = true;
  request.mockReset();
  request.mockImplementation(async (url: string) => Response.json(url === '/api/v2/keys' ? { providers: keyProviders }
    : url === '/api/setup/detect' ? { tools: [{ id: 'codex', detected: true, ready: true, path: '/fixture/codex', version: '1.2.3' }] }
    : { schema: 'o8/runtime-capacity-control/v1', generatedAt: Date.now(), capacities: [], identities: [], runtimes: [] }));
  vi.stubGlobal('fetch', request);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

function tab(label: string) {
  return [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(button => button.getAttribute('aria-label') === label)!;
}

it('opens Codex connection details without changing provider defaults or starting a model request', async () => {
  await act(async () => root.render(createElement(ProvidersTab)));
  expect(tab('Codex').getAttribute('aria-selected')).toBe('true');
  expect(container.querySelector('[role="tabpanel"]:not([hidden])')?.textContent).toContain('/fixture/codex');
  expect(defaults.updateField).not.toHaveBeenCalled();
  expect(request.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  expect(request.mock.calls.some(([url]) => String(url).includes('backend-models'))).toBe(false);
});

it('preserves an unsaved key and avoids mounting unrelated editors when switching providers', async () => {
  await act(async () => root.render(createElement(ProvidersTab)));
  expect(container.querySelector('input[type="password"]')).toBeNull();
  await act(async () => tab('OpenRouter').click());
  const input = container.querySelector<HTMLInputElement>('[aria-label="openrouter key"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'fixture-draft');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => tab('Codex').click());
  expect(input.closest('[hidden]')).not.toBeNull();
  await act(async () => tab('OpenRouter').click());
  expect(container.querySelector('[aria-label="openrouter key"]')).toBe(input);
  expect(input.value).toBe('fixture-draft');
  expect(container.textContent).not.toContain('Voice key editor');
});

it('supports keyboard selection and the legacy key and local-model entry points', async () => {
  await act(async () => root.render(createElement(ProvidersTab, { initialTab: 'api-keys' })));
  expect(tab('OpenRouter').getAttribute('aria-selected')).toBe('true');
  await act(async () => tab('OpenRouter').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })));
  expect(tab('Codex').getAttribute('aria-selected')).toBe('true');
  expect(document.activeElement).toBe(tab('Codex'));
  await act(async () => tab('Codex').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
  expect(tab('Model defaults').getAttribute('aria-selected')).toBe('true');
  await act(async () => root.render(createElement(ProvidersTab, { key: 'local', initialTab: 'local-models' })));
  expect(tab('Local models').getAttribute('aria-selected')).toBe('true');
  expect(container.textContent).toContain('Local model settings');
  expect(defaults.updateField).not.toHaveBeenCalled();
});

it('opens the selected search section in its owning provider pane', async () => {
  await act(async () => root.render(createElement(ProvidersTab, { section: 'Claude Code connection' })));
  expect(tab('Claude Code').getAttribute('aria-selected')).toBe('true');
  expect(container.querySelector('[role="tabpanel"]:not([hidden])')?.textContent).toContain('Claude connection settings');
});

it('shows explicit unavailable account usage for a provider without a quota reader', async () => {
  await act(async () => root.render(createElement(ProviderUsageSection, { runtimeId: 'cursor', label: 'Cursor' })));
  expect(container.textContent).toContain('Account limits are not reported by this connection');
  expect(container.textContent).not.toContain('0%');
  expect(container.querySelector('a')?.href).toBe('https://cursor.com/dashboard/usage');
});

it('labels stale usage, keeps unknown values unknown, and offers a retry after a failed refresh', async () => {
  request.mockResolvedValueOnce(Response.json({ schema: 'o8/runtime-capacity-control/v1', generatedAt: Date.now(), identities: [], runtimes: [], capacities: [
    { runtime: 'codex', identityId: null, status: 'stale', observedAt: '2026-10-10T12:00:00Z', source: 'structured-cli', confidence: 'exact', reason: null,
      buckets: [{ id: 'weekly', label: 'Weekly', usedRatio: 0.87, used: null, remaining: null, unit: null, resetsAt: null, expiresAt: null }] },
  ] }));
  await act(async () => root.render(createElement(ProviderUsageSection, { runtimeId: 'codex', label: 'ChatGPT / Codex' })));
  expect(container.textContent).toContain('87% used');
  expect(container.textContent).toContain('Stale observation');
  expect(container.textContent).toContain('No reset reported');
  request.mockResolvedValueOnce(new Response('', { status: 503 }));
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not refresh account usage');
  expect(container.textContent).toContain('87% used');
  expect(request.mock.calls.at(-1)?.[0]).toBe('/api/runtime/capacity?fresh=1');
  expect(container.querySelector('button')?.disabled).toBe(false);
});


it('identifies multiple accounts and keeps null limits unavailable', async () => {
  request.mockResolvedValueOnce(Response.json({ schema: 'o8/runtime-capacity-control/v1', capacities: ['work', 'personal'].map(identityId => ({
    runtime: 'codex', identityId, status: 'available', observedAt: null, source: 'app-server', confidence: 'exact', reason: null,
    buckets: [{ id: 'weekly', label: 'Weekly', usedRatio: null, used: null, remaining: null, unit: null, resetsAt: null, expiresAt: null }],
  })), identities: [{ id: 'work', runtime: 'codex', label: 'Work account', selected: true }, { id: 'personal', runtime: 'codex', label: 'Personal account', selected: false }] }));
  await act(async () => root.render(createElement(ProviderUsageSection, { runtimeId: 'codex', label: 'ChatGPT / Codex' })));
  expect(container.textContent).toContain('Work account · Selected');
  expect(container.textContent).toContain('Personal account');
  expect(container.querySelector('[role="meter"]')).toBeNull();
  expect(container.textContent).toContain('Usage not reported');
  expect(container.textContent).not.toContain('0%');
});

it('rejects a malformed usage payload without rendering invented account limits', async () => {
  request.mockResolvedValueOnce(Response.json({ schema: 'o8/runtime-capacity-control/v1', capacities: [{ runtime: 'codex', status: 'available', buckets: null }] }));
  await act(async () => root.render(createElement(ProviderUsageSection, { runtimeId: 'codex', label: 'ChatGPT / Codex' })));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not refresh account usage');
  expect(container.querySelector('[role="meter"]')).toBeNull();
});


it('prioritizes installed connections, keeps additional agents discoverable, and puts OpenRouter first', async () => {
  request.mockImplementation(async (url: string) => Response.json(url === '/api/v2/keys' ? { providers: [...keyProviders].reverse() }
    : url === '/api/setup/detect' ? { tools: [{ id: 'codex', detected: true, ready: true }, { id: 'cursor', detected: true, ready: true }] }
    : { schema: 'o8/runtime-capacity-control/v1', capacities: [], identities: [] }));
  await act(async () => root.render(createElement(ProvidersTab)));
  expect(tab('Cursor')).toBeDefined();
  expect(tab('Antigravity')).toBeUndefined();
  const apiTabs = [...container.querySelectorAll('[role="tab"]')].filter(button => ['OpenRouter', 'Anthropic'].includes(button.getAttribute('aria-label') ?? ''));
  expect(apiTabs[0].getAttribute('aria-label')).toBe('OpenRouter');
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Show available agents')!.click());
  expect(tab('Antigravity')).toBeDefined();
  expect(defaults.updateField).not.toHaveBeenCalled();
});


it('reopens a repeated search after manual provider selection', async () => {
  await act(async () => root.render(createElement(ProvidersTab, { section: 'Claude Code connection', navigationId: 1 })));
  await act(async () => tab('Codex').click());
  expect(tab('Codex').getAttribute('aria-selected')).toBe('true');
  await act(async () => root.render(createElement(ProvidersTab, { section: 'Claude Code connection', navigationId: 2 })));
  expect(tab('Claude Code').getAttribute('aria-selected')).toBe('true');
});

it('routes runtime and key section menu headings to their owning provider', async () => {
  await act(async () => root.render(createElement(ProvidersTab)));
  const codexSections = [...container.querySelectorAll('[role="tabpanel"]:not([hidden]) [data-settings-section]')].map(node => node.getAttribute('data-settings-section'));
  expect(codexSections).toEqual(expect.arrayContaining(['Codex runtime', 'Codex models', 'Codex environment']));
  expect(codexSections).not.toEqual(expect.arrayContaining(['Connection', 'Models', 'Environment']));
  await act(async () => tab('Model defaults').click());
  await act(async () => root.render(createElement(ProvidersTab, { section: 'Codex models', navigationId: 1 })));
  expect(tab('Codex').getAttribute('aria-selected')).toBe('true');
  await act(async () => root.render(createElement(ProvidersTab, { section: 'Anthropic key', navigationId: 2 })));
  expect(tab('Anthropic').getAttribute('aria-selected')).toBe('true');
  expect(container.querySelector('[role="tabpanel"]:not([hidden]) [data-settings-section="Anthropic key"]')).not.toBeNull();
});


it('keeps provider details below a horizontal keyboard rail in a narrow panel', async () => {
  let resize: ResizeObserverCallback | undefined;
  const disconnect = vi.fn();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { resize = callback; }
    observe() {}
    disconnect = disconnect;
  });
  await act(async () => root.render(createElement(ProvidersTab)));
  await act(async () => resize!([{ contentRect: { width: 540 } } as ResizeObserverEntry], {} as ResizeObserver));
  const list = container.querySelector<HTMLElement>('[role="tablist"]')!;
  expect(list.getAttribute('aria-orientation')).toBe('horizontal');
  expect(list.style.overflowX).toBe('auto');
  expect(list.parentElement?.parentElement?.style.flexDirection).toBe('column');
  expect(container.querySelector('[role="tabpanel"]:not([hidden])')?.textContent).toContain('Codex runtime');
  await act(async () => tab('Codex').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
  expect(tab('Claude Code').getAttribute('aria-selected')).toBe('true');
  await act(async () => resize!([{ contentRect: { width: 900 } } as ResizeObserverEntry], {} as ResizeObserver));
  expect(list.getAttribute('aria-orientation')).toBe('vertical');
  expect(list.parentElement?.parentElement?.style.flexDirection).toBe('row');
  await act(async () => root.unmount());
  expect(disconnect).toHaveBeenCalledTimes(1);
  root = createRoot(container);
});


it.each([true, false])('keeps the bundled worker discoverable with truthful readiness=%s', async ready => {
  defaults.builtInReady = ready;
  await act(async () => root.render(createElement(ProvidersTab)));
  expect(tab('Pi (built-in)')).toBeDefined();
  await act(async () => tab('Pi (built-in)').click());
  const pane = container.querySelector('[role="tabpanel"]:not([hidden])')!;
  expect(pane.textContent).toContain(ready ? 'Bundled and ready' : 'Requires Node 22.19 or newer');
  expect(pane.textContent).not.toContain('Binary path');
  expect(pane.textContent).not.toContain('Sign in through');
  expect(request.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
});
