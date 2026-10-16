// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/desktop/settings/shared', () => ({ RamsButton: ({ children, onClick }: { children: React.ReactNode; onClick: () => void }) => React.createElement('button', { onClick }, children) }));
const { VisualizationQuestion } = await import('@/components/desktop/visualizations/VisualizationQuestion');
let root: Root, node: HTMLDivElement;
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 0; });
});
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals(); });

describe('reviewing a visualization question before adding it to chat', () => {
  it('keeps the existing selected draft, appends only on host click, and never submits', async () => {
    const composer = document.createElement('textarea'); composer.dataset.o8ActiveComposer = 'true'; composer.value = 'Keep my draft'; composer.setSelectionRange(0, 4); document.body.append(composer);
    const submit = vi.fn(); document.addEventListener('submit', submit);
    const close = vi.fn();
    try {
      await act(async () => root.render(React.createElement(VisualizationQuestion, { title: 'Comparison', question: 'Explain the difference', onClose: close })));
      expect(composer.value).toBe('Keep my draft');
      await act(async () => [...node.querySelectorAll('button')].find(button => button.textContent === 'Add to chat')!.click());
      expect(composer.value).toBe('Keep my draft\n\nAbout “Comparison”: Explain the difference\n');
      expect(close).toHaveBeenCalledTimes(1); expect(submit).not.toHaveBeenCalled();
    } finally { document.removeEventListener('submit', submit); }
  });
  it('leaves the proposal visible when no composer is open and can dismiss it without side effects', async () => {
    const close = vi.fn();
    await act(async () => root.render(React.createElement(VisualizationQuestion, { title: 'Comparison', question: 'Explain', onClose: close })));
    await act(async () => node.querySelector('button')!.click());
    expect(node.querySelector('[role="status"]')?.textContent).toContain('Open a chat composer'); expect(close).not.toHaveBeenCalled();
    await act(async () => [...node.querySelectorAll('button')].find(button => button.textContent === 'Dismiss')!.click());
    expect(close).toHaveBeenCalledTimes(1);
  });
});
