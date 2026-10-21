import { describe, expect, it } from 'vitest';
import { fitPipLayout } from './pip-layout';
describe('workspace PiP bounds', () => {
  const shape = { width: 440, frameHeight: 264, viewport: 1200 };
  it('keeps a saved offscreen player wholly inside a narrow workspace', () => {
    const fitted = fitPipLayout({ left: 300, top: 40, width: 250, height: 400 }, shape, { x: -1000, y: 9999 });
    expect(fitted.position.x).toBeGreaterThanOrEqual(308); expect(fitted.position.x + fitted.shape.width).toBeLessThanOrEqual(542);
    expect(fitted.position.y + fitted.shape.frameHeight + 30).toBeLessThanOrEqual(432);
  });
  it('keeps the whole player above the active composer when their columns overlap', () => {
    const fitted = fitPipLayout({ left: 0, top: 40, width: 800, height: 600 }, shape, { x: 350, y: 500 }, { left: 20, top: 400, width: 760, height: 200 });
    expect(fitted.position.y + fitted.shape.frameHeight + 30).toBeLessThanOrEqual(392);
  });
  it('allows the player beside a composer rather than reserving its entire row', () => {
    const fitted = fitPipLayout({ left: 0, top: 0, width: 1000, height: 600 }, shape, { x: 550, y: 250 }, { left: 0, top: 300, width: 400, height: 300 });
    expect(fitted.position.y).toBe(250); expect(fitted.shape.width).toBe(440);
  });
});
