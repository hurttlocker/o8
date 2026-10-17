// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SubagentDemoPanel } from '@/components/desktop/workspace-terminal/SubagentDemoPanel';

let host: HTMLDivElement;
let root: Root;
let network: ReturnType<typeof vi.fn>;
const click = async (label: string) => {
  const button = [...host.querySelectorAll('button')].find(node => node.textContent === label || node.getAttribute('aria-label') === label || node.title === label);
  expect(button, label).toBeTruthy();
  await act(async () => button!.click());
};
beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  network = vi.fn(() => { throw new Error('Demo made a network request'); });
  vi.stubGlobal('fetch', network);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Demo persisted settings'); });
  host = document.createElement('div'); document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(SubagentDemoPanel, { onClose: vi.fn() })));
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it('opens the exact worker and reconciles review and failure in the real card without dispatch', async () => {
  await click('Open Review keyboard navigation');
  expect(host.querySelector('[data-demo-worker]')?.getAttribute('data-demo-worker')).toBe('demo-review');
  await click('Simulate failure');
  expect(host.textContent).toContain('1 failed');
  await click('Simulate finish');
  expect(host.textContent).toContain('1 awaiting review');
  expect(host.textContent).not.toContain('1 done');
  await click('Review merge for Review keyboard navigation');
  expect(host.textContent).toContain('No merge or acceptance is recorded');
  expect(network).not.toHaveBeenCalled();
});

it('uses the chosen default only for new work and honors a task override', async () => {
  await click('Default worker: Codex, runtime default');
  await click('Claude Code');
  await click('Add demo task');
  expect(host.querySelector('[data-demo-worker]')?.textContent).toContain('Claude Code');
  await click('Open Refine the composer layout');
  expect(host.querySelector('[data-demo-worker]')?.textContent).toContain('Codex');
  await click('Reset demo');
  const select = host.querySelector<HTMLSelectElement>('select[aria-label="Runtime for demo task"]')!;
  await act(async () => { select.value = 'claude-code'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await click('Add demo task');
  expect(host.querySelector('[data-demo-worker]')?.textContent).toContain('Task override');
  expect(host.querySelector('[data-demo-worker]')?.textContent).toContain('Claude Code');
  expect(network).not.toHaveBeenCalled();
});
