// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HeaderPillStrip } from './WorkspaceHeaderStrip';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const tabs = Array.from({ length: 6 }, (_, index) => ({ id: `tab-${index}`, label: `Session ${index}`, kind: 'orchestrator', runtime: null, packetStatus: null }));
let host: HTMLDivElement;
let root: Root;
let scroller: HTMLDivElement;
let pills: HTMLElement[];
let scrollBy: ReturnType<typeof vi.fn>;
let resize: () => void;
const selected = vi.fn();
const onSelect = (event: Event) => selected((event as CustomEvent).detail);

beforeEach(async () => {
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() {} });
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
  selected.mockClear();
  window.addEventListener('o8:request-select-tab', onSelect);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(createElement(HeaderPillStrip, { tabs, activeTabId: tabs[0].id, workspaceId: 'fixture-workspace' })));
  scroller = host.querySelector<HTMLDivElement>('[role="tablist"]')!;
  Object.defineProperties(scroller, { clientWidth: { value: 200, configurable: true }, scrollWidth: { value: 600, configurable: true } });
  // The shell can apply CSS zoom; positions use viewport pixels while scrolling
  // uses layout pixels. Exercise both through the real component.
  vi.spyOn(scroller, 'getBoundingClientRect').mockImplementation(() => new DOMRect(100, 10, scroller.clientWidth * 1.25, 32));
  pills = Array.from(scroller.querySelectorAll<HTMLElement>('[role="tab"]'));
  pills.forEach((pill, index) => {
    const bounds = () => new DOMRect(100 + (index * 100 - scroller.scrollLeft) * 1.25, 10, 100, 32);
    vi.spyOn(pill, 'getBoundingClientRect').mockImplementation(bounds);
    vi.spyOn(pill.parentElement!, 'getBoundingClientRect').mockImplementation(bounds);
  });
  scrollBy = vi.fn((options: ScrollToOptions) => {
    scroller.scrollLeft = Math.max(0, Math.min(400, scroller.scrollLeft + (options.left ?? 0)));
    scroller.dispatchEvent(new Event('scroll'));
  });
  Object.defineProperty(scroller, 'scrollBy', { configurable: true, value: scrollBy });
  await act(async () => scroller.dispatchEvent(new Event('scroll')));
});

afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  window.removeEventListener('o8:request-select-tab', onSelect);
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

async function wheel(target: Element, options: WheelEventInit) {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...options });
  await act(async () => target.dispatchEvent(event));
  return event;
}

it.each([
  { mode: 0, delta: 40, expected: 40 },
  { mode: 1, delta: 3, expected: 48 },
  { mode: 2, delta: 1, expected: 200 },
])('scrolls overflow from a vertical mouse wheel in delta mode $mode without switching tabs', async ({ mode, delta, expected }) => {
  const event = await wheel(pills[0], { deltaY: delta, deltaMode: mode });
  expect(scroller.scrollLeft).toBe(expected);
  expect(event.defaultPrevented).toBe(true);
  expect(selected).not.toHaveBeenCalled();
  expect(pills[0].getAttribute('aria-selected')).toBe('true');
  const reverse = await wheel(scroller, { deltaY: -delta, deltaMode: mode });
  expect(scroller.scrollLeft).toBe(0);
  expect(reverse.defaultPrevented).toBe(true);
});

it.each([{ deltaX: 30, deltaY: 0 }, { deltaX: 6, deltaY: 35 }])('leaves horizontal and diagonal trackpad gestures native: $deltaX / $deltaY', async options => {
  const event = await wheel(pills[1], options);
  expect(event.defaultPrevented).toBe(false);
  expect(scroller.scrollLeft).toBe(0);
  expect(scroller.style.overscrollBehaviorX).toBe('contain');
});

it.each([{ ctrlKey: true }, { metaKey: true }])('preserves browser zoom gestures: $ctrlKey / $metaKey', async modifier => {
  const event = await wheel(pills[0], { deltaY: 60, ...modifier });
  expect(event.defaultPrevented).toBe(false);
  expect(scroller.scrollLeft).toBe(0);
});

it('only consumes wheel events while there is room in the requested direction', async () => {
  expect((await wheel(scroller, { deltaY: -30 })).defaultPrevented).toBe(false);
  expect((await wheel(scroller, { deltaY: 1000 })).defaultPrevented).toBe(true);
  expect(scroller.scrollLeft).toBe(400);
  expect(host.querySelector('[aria-label="Scroll tabs right"]')).toBeNull();
  expect((await wheel(scroller, { deltaY: 30 })).defaultPrevented).toBe(false);
  await act(async () => { scroller.scrollLeft = 0; Object.defineProperty(scroller, 'scrollWidth', { value: 200 }); });
  expect((await wheel(scroller, { deltaY: 30 })).defaultPrevented).toBe(false);
  expect(scroller.scrollLeft).toBe(0);
});

it('honors noncancelable and already-handled gestures', async () => {
  expect((await wheel(scroller, { deltaY: 30, cancelable: false })).defaultPrevented).toBe(false);
  const stop = (event: Event) => event.preventDefault();
  pills[0].addEventListener('wheel', stop);
  await wheel(pills[0], { deltaY: 30 });
  pills[0].removeEventListener('wheel', stop);
  expect(scroller.scrollLeft).toBe(0);
});

it('scrolls while the pointer is over the pinned overflow arrows too', async () => {
  const right = host.querySelector('[aria-label="Scroll tabs right"]')!;
  expect((await wheel(right, { deltaY: 45 })).defaultPrevented).toBe(true);
  expect(scroller.scrollLeft).toBe(45);
  const left = host.querySelector('[aria-label="Scroll tabs left"]')!;
  expect((await wheel(left, { deltaX: -25 })).defaultPrevented).toBe(true);
  expect(scroller.scrollLeft).toBe(20);
});

it('supports click arrows with reduced-motion preferences', async () => {
  vi.mocked(window.matchMedia).mockReturnValue({ matches: true } as MediaQueryList);
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Scroll tabs right"]')!.click());
  expect(scrollBy).toHaveBeenCalledWith({ left: 140, behavior: 'auto' });
  vi.mocked(window.matchMedia).mockReturnValue({ matches: false } as MediaQueryList);
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Scroll tabs left"]')!.click());
  expect(scrollBy).toHaveBeenLastCalledWith({ left: -140, behavior: 'smooth' });
});

it('reveals an off-screen keyboard target within the strip and selects only on Enter', async () => {
  const focus = vi.spyOn(pills[5], 'focus');
  await act(async () => { pills[0].focus(); pills[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true })); });
  expect(document.activeElement).toBe(pills[5]);
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  expect(scroller.scrollLeft).toBe(400);
  expect(scrollBy).not.toHaveBeenCalled();
  expect(selected).not.toHaveBeenCalled();
  await act(async () => pills[5].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  expect(selected).toHaveBeenCalledExactlyOnceWith({ tabId: 'tab-5', workspaceId: 'fixture-workspace' });
  await act(async () => pills[5].dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })));
  expect(document.activeElement).toBe(pills[0]);
  expect(scroller.scrollLeft).toBe(0);
});

it('reveals externally selected tabs without scrolling the surrounding workspace', async () => {
  const outerScroll = vi.fn(); host.scrollIntoView = outerScroll;
  await act(async () => root.render(createElement(HeaderPillStrip, { tabs, activeTabId: 'tab-5', workspaceId: 'fixture-workspace' })));
  expect(scroller.scrollLeft).toBe(400);
  expect(outerScroll).not.toHaveBeenCalled();
});

it('keeps the active or keyboard-focused tab visible when the available width shrinks', async () => {
  await act(async () => root.render(createElement(HeaderPillStrip, { tabs, activeTabId: 'tab-5', workspaceId: 'fixture-workspace' })));
  await act(async () => { Object.defineProperty(scroller, 'clientWidth', { value: 100 }); resize(); });
  const viewport = scroller.getBoundingClientRect();
  const target = pills[5].getBoundingClientRect();
  expect(target.left).toBeGreaterThanOrEqual(viewport.left);
  expect(target.right).toBeLessThanOrEqual(viewport.right);
  const settledPosition = scroller.scrollLeft;
  await act(async () => resize());
  expect(scroller.scrollLeft).toBe(settledPosition);
  await act(async () => { pills[0].focus(); Object.defineProperty(scroller, 'clientWidth', { value: 70 }); resize(); });
  expect(scroller.scrollLeft).toBe(0);
  expect(document.activeElement).toBe(pills[0]);
  expect(selected).not.toHaveBeenCalled();
});

it('does not take over modified keyboard shortcuts or text-editing keys', async () => {
  await act(async () => pills[1].focus());
  const modified = new KeyboardEvent('keydown', { key: 'ArrowRight', metaKey: true, bubbles: true, cancelable: true });
  await act(async () => pills[1].dispatchEvent(modified));
  expect(document.activeElement).toBe(pills[1]); expect(modified.defaultPrevented).toBe(false);
  await act(async () => pills[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true })));
  const rename = host.querySelector<HTMLInputElement>('input[aria-label="Rename Session 1"]')!;
  await act(async () => { rename.focus(); rename.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })); });
  expect(document.activeElement).toBe(rename);
  expect(selected).not.toHaveBeenCalled();
});
