// @vitest-environment jsdom

import { act, createElement, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useWorkerPaneSize } from './useWorkerPaneSize';
import { WorkerPaneHeader } from './WorkerPaneHeader';
import { WorkerPaneComposer } from './WorkerPaneComposer';
import { TabBar } from './TabBar';
import type { TerminalTab } from './types';
import { workerAttention } from './worker-pane-chrome';

vi.mock('./WorkspaceLaunchPicker', () => ({ WorkspaceLaunchPicker: () => null }));
vi.mock('@/components/desktop/thoughts/AttachFilesButton', () => ({ AttachFilesButton: () => createElement('button', { type: 'button' }, 'Attach files') }));

let root: Root;
let host: HTMLDivElement;
let observers: Array<{ callback: ResizeObserverCallback; node?: Element; disconnect: () => void }>;

beforeEach(() => {
  observers = [];
  vi.stubGlobal('ResizeObserver', class {
    entry: typeof observers[number];
    constructor(callback: ResizeObserverCallback) {
      this.entry = { callback, disconnect: vi.fn() };
      observers.push(this.entry);
    }
    observe(node: Element) { this.entry.node = node; }
    disconnect() { this.entry.disconnect(); }
  });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function FrameFixture() {
  const { paneRef, compact } = useWorkerPaneSize();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  return createElement('div', { ref: paneRef, 'data-pane': true, 'data-compact': compact },
    createElement(WorkerPaneHeader, { title: 'Repair input', branch: 'issue/4080-repair-input', issueNumber: 4080,
      runtime: 'Worker runtime', model: 'Model', compact, status: 'running', statusLabel: 'Running' }),
    // eslint-disable-next-line react-hooks/refs -- createElement forwards this ref; the composer reads it only in effects and events.
    createElement(WorkerPaneComposer, { textareaRef, scopeKey: 'test-pane', active: false, compact, input: '',
      onInputChange: vi.fn(), onSend: vi.fn(), canSend: false }),
  );
}

it('switches each pane from its observed width and height, and disconnects on unmount', () => {
  act(() => root.render(createElement(FrameFixture)));
  const pane = host.querySelector('[data-pane]')!;
  const observer = observers.find(entry => entry.node === pane)!;
  const resize = (width: number, height: number) => act(() => observer.callback([
    { contentRect: { width, height } } as ResizeObserverEntry,
  ], {} as ResizeObserver));
  resize(700, 500);
  expect(pane.getAttribute('data-compact')).toBe('false');
  expect(host.querySelector('[aria-label="Add to message"]')).toBeNull();
  resize(479, 500);
  expect(pane.getAttribute('data-compact')).toBe('true');
  expect(host.querySelector('[aria-label="Add to message"]')).not.toBeNull();
  resize(800, 359);
  expect(pane.getAttribute('data-compact')).toBe('true');
  resize(480, 360);
  expect(pane.getAttribute('data-compact')).toBe('false');
  act(() => root.render(null));
  expect(observer.disconnect).toHaveBeenCalledOnce();
});

it('keeps the full branch in the header tooltip and hides idle state controls', () => {
  act(() => root.render(createElement(FrameFixture)));
  expect(host.querySelector('[data-worker-title]')?.getAttribute('title')).toBe('issue/4080-repair-input');
  expect(host.querySelector('[data-worker-pane-header]')?.textContent).toContain('#4080');
  expect(host.querySelector('[data-worker-state-row]')).toBeNull();
  const add = host.querySelector<HTMLButtonElement>('[aria-label="Add to message"]')!;
  act(() => add.click());
  expect(add.getAttribute('aria-expanded')).toBe('true');
  expect(host.textContent).toContain('Attach files');
});

it('renders distinct full thread titles and a complete label in the real tab bar', () => {
  const tabs: TerminalTab[] = ['Add support for worker panes', 'Check compact frames', 'Build exit:'].map((llmSummary, index) => ({
    id: `${index}`, label: 'Orchestrator', kind: 'orchestrator', llmSummary, tmuxSession: null, createdAt: 0, lastActivity: 0,
  }));
  const select = vi.fn();
  act(() => root.render(createElement(TabBar, { tabs, activeTabId: '0', onSelectTab: select,
    onCloseTab: vi.fn(), onNewTab: vi.fn(), onNewLLMChatTab: vi.fn() })));
  const buttons = host.querySelectorAll<HTMLButtonElement>('[data-worker-tab-label]');
  expect([...buttons].map(button => button.dataset.workerTabLabel)).toEqual(['Add support for worker panes', 'Check compact frames', 'Build exit']);
  act(() => buttons[1].click());
  expect(select).toHaveBeenCalledWith('1');
});

it.each([
  ['paused', undefined, ['Resume', 'Stop']],
  ['blocked', 'CI', ['Open checks', 'Stop']],
  ['blocked', 'worktree_conflict', ['Open details', 'Stop']],
  ['blocked', 'worker_question', []],
  ['waiting', undefined, []],
  ['awaiting_review', undefined, ['Review', 'Stop']],
] as const)('renders and binds only the actions for %s / %s', (status, reason, labels) => {
  const resume = vi.fn(); const stop = vi.fn(); const openReview = vi.fn();
  function AttentionFixture() {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    // eslint-disable-next-line react-hooks/refs -- createElement forwards this ref; the composer reads it only in effects and events.
    return createElement(WorkerPaneComposer, { textareaRef, scopeKey: 'attention', active: false, compact: true, input: '',
      onInputChange: vi.fn(), onSend: vi.fn(), disabled: status === 'blocked' && reason !== 'worker_question', canSend: false,
      attention: workerAttention(status, reason), onResume: resume, onStop: stop, onOpenReview: openReview });
  }
  act(() => root.render(createElement(AttentionFixture)));
  const row = host.querySelector('[data-worker-state-row]')!;
  const actions = [...row.querySelectorAll('button')];
  expect(actions.map(button => button.textContent)).toEqual(labels);
  for (const button of actions) {
    expect(button.disabled).toBe(false);
    act(() => button.click());
  }
  expect(resume).toHaveBeenCalledTimes(labels.some(label => label === 'Resume') ? 1 : 0);
  expect(stop).toHaveBeenCalledTimes(labels.some(label => label === 'Stop') ? 1 : 0);
  expect(openReview).toHaveBeenCalledTimes(labels.some(label => label === 'Review' || label.startsWith('Open')) ? 1 : 0);
  if (!labels.length) {
    expect(row.textContent).toBe('Waiting');
    expect(host.querySelector('textarea')?.disabled).toBe(false);
  }
});
