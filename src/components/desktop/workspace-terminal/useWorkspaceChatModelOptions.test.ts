// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { WorkspaceChatRuntime } from './types';
const state = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('@/lib/setup/detection-cache', () => ({ getCachedOpenCodeProviders: () => [], loadOpenCodeProviders: state.load }));
import { useWorkspaceChatModelOptions } from './useWorkspaceChatModelOptions';
it('keeps a persisted selection and never substitutes Codex models for another runtime', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'); const root = createRoot(host);
  const Harness = ({ runtime, selected }: { runtime: WorkspaceChatRuntime; selected?: string }) => {
    const options = useWorkspaceChatModelOptions(runtime, selected);
    return createElement('div', { 'data-model': options.selectedModel.id, 'data-count': options.availableModels.length }, options.selectedModelLabel);
  };
  await act(async () => root.render(createElement(Harness, { runtime: 'muse', selected: 'saved/muse-model' })));
  expect(host.querySelector('[data-model]')?.getAttribute('data-model')).toBe('saved/muse-model');
  expect(host.querySelector('[data-count]')?.getAttribute('data-count')).toBe('0');
  await act(async () => root.render(createElement(Harness, { runtime: 'pi', selected: undefined })));
  expect(host.textContent).toBe('Agent default');
  await act(async () => root.unmount());
});
it('retries provider discovery after switching away during a pending read', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let first!: (value: string[]) => void; let second!: (value: string[]) => void;
  state.load.mockReset().mockImplementationOnce(() => new Promise(resolve => { first = resolve; })).mockImplementationOnce(() => new Promise(resolve => { second = resolve; }));
  const host = document.createElement('div'); const root = createRoot(host);
  function Harness({ runtime }: { runtime: WorkspaceChatRuntime }) { return createElement('div', null, useWorkspaceChatModelOptions(runtime, 'saved/model').selectedModelLabel); }
  const render = (runtime: WorkspaceChatRuntime) => act(async () => root.render(createElement(Harness, { runtime })));
  await render('opencode'); await render('codex'); await render('opencode');
  expect(state.load).toHaveBeenCalledTimes(2);
  await act(async () => first(['stale-provider'])); expect(host.textContent).toBe('saved/model');
  await act(async () => second(['openrouter'])); expect(host.textContent).toBe('saved/model');
  await act(async () => root.unmount());
});
