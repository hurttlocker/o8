// @vitest-environment jsdom
import { act, createElement, useLayoutEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RightPrTabs } from './RightPrTabs';
import { useRightPrTabs } from './useRightPrTabs';
let host: HTMLDivElement; let root: Root; let state: ReturnType<typeof useRightPrTabs>;
function Fixture() {
  const current = useRightPrTabs();
  useLayoutEffect(() => { state = current; }, [current]);
  const [activeId, setActiveId] = useState<string | null>(null);
  return createElement(RightPrTabs, { tabs: current.tabs, activeId, onSelect: (tab) => setActiveId(tab.id), onClose: (tab) => current.close(tab.id) });
}
beforeEach(async () => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); host = document.createElement('div'); document.body.append(host); root = createRoot(host); await act(async () => root.render(createElement(Fixture))); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
describe('open pull request tabs', () => {
  it('keeps opening order stable, reuses an existing PR, and separates the same number across repositories', async () => {
    await act(async () => { state.open(7, 'example/first', '/workspace/first'); state.open(8, 'example/first', '/workspace/first'); state.open(7, 'example/second', '/workspace/second'); });
    await act(async () => state.open(7, 'example/first', '/workspace/another-checkout'));
    const tabs = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    expect(tabs.map((tab) => tab.getAttribute('aria-label'))).toEqual(['PR #7 in example/first', 'PR #8 in example/first', 'PR #7 in example/second']);
    expect(state.tabs[0].repoPath).toBe('/workspace/another-checkout');
    await act(async () => tabs[0].click()); tabs[0].focus();
    await act(async () => tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
    expect(document.activeElement).toBe(tabs[2]);
    expect(tabs[2].getAttribute('aria-selected')).toBe('true');
    expect(host.querySelectorAll('[role="tab"][tabindex="0"]')).toHaveLength(1);
    expect(state.tabs.map((tab) => tab.number)).toEqual([7, 8, 7]);
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Close PR #7 in example/first"]')!.click());
    expect(state.tabs.map((tab) => tab.id)).toEqual(['example/first#8', 'example/second#7']);
  });
});
