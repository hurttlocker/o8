// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RightUtilityTabStrip, type RightUtilityTab } from './O8PanelUtilityTabs';
import type { O8Tab } from './types';

let host: HTMLDivElement; let root: Root;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });
function Tabs({ initialTabs = ['files', 'review'] }: { initialTabs?: RightUtilityTab[] }) {
  const [tabs, setTabs] = useState<RightUtilityTab[]>(initialTabs);
  const [activeTab, setActiveTab] = useState<O8Tab>('files');
  return createElement(RightUtilityTabStrip, { tabs, activeTab, inHeader: true, onOpenLauncher: () => setActiveTab('launcher'), onSelect: setActiveTab,
    onClose: tab => { const remaining = tabs.filter(item => item !== tab); setTabs(remaining); if (activeTab === tab) setActiveTab(remaining[0] ?? 'launcher'); } });
}
describe('right panel header tabs', () => {
  it('scrolls overflowing tabs with a mouse wheel and reveals keyboard selections in the strip', async () => {
    await act(async () => root.render(createElement(Tabs, { initialTabs: ['files', 'side-chat', 'review', 'inbox'] })));
    const strip = host.querySelector<HTMLDivElement>('[role="tablist"]')!;
    Object.defineProperties(strip, { clientWidth: { value: 120 }, scrollWidth: { value: 500 } });
    strip.getBoundingClientRect = () => ({ left: 0, right: 120, width: 120, top: 0, bottom: 28, height: 28, x: 0, y: 0, toJSON: () => ({}) });
    Array.from(strip.querySelectorAll<HTMLElement>('[role="tab"]')).forEach((tab, index) => {
      tab.getBoundingClientRect = () => ({ left: index * 100 - strip.scrollLeft, right: (index + 1) * 100 - strip.scrollLeft, width: 100, top: 0, bottom: 28, height: 28, x: 0, y: 0, toJSON: () => ({}) });
      tab.parentElement!.getBoundingClientRect = tab.getBoundingClientRect;
    });
    const wheel = new WheelEvent('wheel', { deltaY: 80, bubbles: true, cancelable: true });
    strip.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true); expect(strip.scrollLeft).toBe(80);
    const files = strip.querySelector<HTMLButtonElement>('[aria-label="Files"]')!;
    await act(async () => { files.focus(); files.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })); });
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Inbox');
    const selected = document.activeElement!;
    expect(selected.getBoundingClientRect().left).toBeGreaterThanOrEqual(0);
    expect(selected.getBoundingClientRect().right).toBeLessThanOrEqual(strip.clientWidth);
    const position = strip.scrollLeft;
    const horizontal = new WheelEvent('wheel', { deltaX: 40, bubbles: true, cancelable: true });
    strip.dispatchEvent(horizontal);
    expect(horizontal.defaultPrevented).toBe(false); expect(strip.scrollLeft).toBe(position);
  });

  it('switches and closes tabs with the keyboard, then opens a named landing tab', async () => {
    await act(async () => root.render(createElement(Tabs)));
    const files = host.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Files"]')!;
    files.focus(); await act(async () => files.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Review');
    expect(document.activeElement?.getAttribute('aria-selected')).toBe('true');
    await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })));
    expect(host.querySelector('[aria-label="Review"]')).toBeNull();
    expect(document.activeElement).toBe(files);
    const close = host.querySelector<HTMLButtonElement>('[aria-label="Close Files tab"]')!;
    close.focus(); await act(async () => close.click());
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Open right panel tab picker');
    expect(host.querySelector('[role="tab"]')?.textContent).toBe('New tab');
  });
  it('keeps the active tab and focus when closing an inactive tab', async () => {
    await act(async () => root.render(createElement(Tabs)));
    const close = host.querySelector<HTMLButtonElement>('[aria-label="Close Review tab"]')!;
    close.focus(); await act(async () => close.click());
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Files');
    expect(document.activeElement?.getAttribute('aria-selected')).toBe('true');
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Open right panel tab picker"]')!.click());
    const landing = host.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')!;
    landing.focus(); await act(async () => landing.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })));
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Files');
  });

});
