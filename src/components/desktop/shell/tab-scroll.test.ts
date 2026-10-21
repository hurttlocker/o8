// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { revealHeaderTab, scrollTabStripFromWheel } from './tab-scroll';

function scroller() {
  const strip = document.createElement('div');
  Object.defineProperties(strip, { clientWidth: { value: 200 }, scrollWidth: { value: 600 } });
  return strip;
}

describe('shared tab strip scrolling', () => {
  it.each([[0, 30, 30], [1, 2, 32], [2, 1, 200]])('maps wheel units %s to document pixels', (deltaMode, deltaY, expected) => {
    const strip = scroller();
    const event = new WheelEvent('wheel', { deltaMode, deltaY, cancelable: true });
    expect(scrollTabStripFromWheel(strip, event)).toBe(true);
    expect(strip.scrollLeft).toBe(expected); expect(event.defaultPrevented).toBe(true);
  });

  it('leaves zoom, handled events, and scroll boundaries to their owner', () => {
    const strip = scroller();
    const events = [
      new WheelEvent('wheel', { deltaY: 40, ctrlKey: true, cancelable: true }),
      new WheelEvent('wheel', { deltaY: 40, metaKey: true, cancelable: true }),
      new WheelEvent('wheel', { deltaY: 40 }),
      new WheelEvent('wheel', { deltaY: -40, cancelable: true }),
    ];
    for (const event of events) {
      expect(scrollTabStripFromWheel(strip, event)).toBe(false);
      expect(event.defaultPrevented).toBe(false);
    }
    const handled = new WheelEvent('wheel', { deltaY: 40, cancelable: true }); handled.preventDefault();
    expect(scrollTabStripFromWheel(strip, handled)).toBe(false);
    strip.scrollLeft = 400;
    const boundary = new WheelEvent('wheel', { deltaY: 40, cancelable: true });
    expect(scrollTabStripFromWheel(strip, boundary)).toBe(false); expect(boundary.defaultPrevented).toBe(false);
  });

  it('reveals a selected tab in a zoomed strip without scrolling its page', () => {
    const strip = scroller(); const tab = document.createElement('button'); strip.append(tab);
    strip.getBoundingClientRect = () => ({ left: 100, right: 350, width: 250, top: 0, bottom: 35, height: 35, x: 100, y: 0, toJSON: () => ({}) });
    tab.getBoundingClientRect = () => ({ left: 425, right: 550, width: 125, top: 0, bottom: 35, height: 35, x: 425, y: 0, toJSON: () => ({}) });
    revealHeaderTab(strip, tab);
    expect(strip.scrollLeft).toBe(182);
    expect(window.scrollX).toBe(0);
  });

  it('settles on the leading edge when a tab is wider than the available strip', () => {
    const strip = scroller(); const tab = document.createElement('button'); strip.append(tab);
    strip.getBoundingClientRect = () => ({ left: 0, right: 200, width: 200, top: 0, bottom: 28, height: 28, x: 0, y: 0, toJSON: () => ({}) });
    tab.getBoundingClientRect = () => ({ left: 300 - strip.scrollLeft, right: 560 - strip.scrollLeft, width: 260, top: 0, bottom: 28, height: 28, x: 0, y: 0, toJSON: () => ({}) });
    revealHeaderTab(strip, tab); const position = strip.scrollLeft;
    revealHeaderTab(strip, tab);
    expect(position).toBe(300); expect(strip.scrollLeft).toBe(position);
  });
});
