// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ORCHESTRATOR_RUNTIMES } from '@/lib/orchestrator/runtime-capabilities';
import { SubagentDemoPanel } from '@/components/desktop/workspace-terminal/SubagentDemoPanel';

vi.mock('@/lib/pretext', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/pretext')>(), usePretextHeight: () => 24 }));

let host: HTMLDivElement;
let root: Root;
let network: ReturnType<typeof vi.fn>;
const expectReadOnlyComposerRequests = () => {
  for (const [url, init] of network.mock.calls) {
    expect(['/api/runtime/claude-code-profile', '/api/panel/operator-defaults?include=values']).toContain(url);
    expect(init?.method ?? 'GET').toBe('GET');
  }
};
const typeMessage = async (text: string) => {
  const textarea = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Orchestrator"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, text);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const click = async (label: string) => {
  const button = [...host.querySelectorAll('button')].find(node => node.textContent === label || node.getAttribute('aria-label') === label || node.title === label);
  expect(button, label).toBeTruthy();
  await act(async () => button!.click());
};
beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  network = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method && init.method !== 'GET') throw new Error('Demo attempted a network mutation');
    return { ok: false, json: async () => ({}) };
  });
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
  await click('Send (Enter)');
  await click('Open Review keyboard navigation');
  expect(host.querySelector('[data-demo-worker]')?.getAttribute('data-demo-worker')).toBe('demo-review');
  await click('Simulate failure');
  expect(host.textContent).toContain('1 failed');
  await click('Simulate finish');
  expect(host.textContent).toContain('1 awaiting review');
  expect(host.textContent).not.toContain('1 done');
  await click('Review merge for Review keyboard navigation');
  expect(host.textContent).toContain('No merge or acceptance is recorded');
  expectReadOnlyComposerRequests();
});

it('uses the chosen default only for new work and honors a task override', async () => {
  await click('Send (Enter)');
  await click('Default worker: Codex, runtime default');
  await click('Claude Code');
  await typeMessage('Check the final interaction');
  await click('Send (Enter)');
  expect(host.querySelector('[data-demo-worker]')?.textContent).toContain('Claude Code');
  await click('Open Refine the composer layout');
  expect(host.querySelector('[data-demo-worker]')?.textContent).toContain('Codex');
  await click('Reset demo');
  await click('Send (Enter)');
  const select = host.querySelector<HTMLSelectElement>('select[aria-label="Runtime for demo task"]')!;
  await act(async () => { select.value = 'claude-code'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await typeMessage('Review this task');
  await click('Send (Enter)');
  expect(host.querySelector('[data-demo-worker]')?.textContent).toContain('Task override');
  expect(host.querySelector('[data-demo-worker]')?.textContent).toContain('Claude Code');
  expectReadOnlyComposerRequests();
});

it('starts as a chat and places every dispatchable runtime after the prompt and reply', async () => {
  expect(host.querySelector('[data-swarm-crew]')).toBeNull();
  const composer = host.querySelector('[data-o8-composer-root]')!;
  expect(composer.querySelector('textarea[aria-label="Message Orchestrator"]')).not.toBeNull();
  expect(composer.querySelector('[data-testid="composer-send-control"]')).not.toBeNull();
  await click('Send (Enter)');
  const transcript = host.querySelector('[data-demo-transcript]')!;
  expect(transcript.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(host.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('');
  const text = transcript.textContent!;
  expect(text.indexOf('Delegate this work')).toBeLessThan(text.indexOf('I’ll split'));
  expect(text.indexOf('I’ll split')).toBeLessThan(text.indexOf('subagents'));
  for (const capability of Object.values(ORCHESTRATOR_RUNTIMES).filter(item => item.dispatchable)) {
    expect(transcript.querySelector('[data-swarm-crew]')?.textContent).toContain(capability.label);
  }
  expect(host.textContent).toContain('Examples, not installed availability');
  await typeMessage('Check the composer below the transcript');
  await act(async () => host.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
  expect(transcript.textContent).toContain('Check the composer below the transcript');
  expect(host.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('');
  expectReadOnlyComposerRequests();
});
