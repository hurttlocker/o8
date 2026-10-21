// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { visualizationState } from '@/lib/visualizations/view-state';
import { readVisualizationState, writeVisualizationState, VISUALIZATION_STATE_EVENT } from '@/components/desktop/visualizations/view-state';

afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });
describe('presentation-only visualization choices', () => {
  it('clones a bounded JSON snapshot and rejects excessive or unsafe state', () => {
    const input = { measure: 'tasks', charts: { activity: { hidden: ['review'] } } };
    expect(visualizationState(input)).toEqual(input);
    expect(visualizationState(input)).not.toBe(input);
    for (const value of [[], null, { n: Infinity }, { n: NaN }, { large: 'x'.repeat(8193) }, { a: 'é'.repeat(8000), b: 'é'.repeat(8000) }, JSON.parse('{"__proto__":{}}')]) expect(visualizationState(value)).toBeNull();
    const deep: Record<string, unknown> = {}; let nested = deep;
    for (let i = 0; i < 14; i++) { nested.child = {}; nested = nested.child as Record<string, unknown>; }
    expect(visualizationState(deep)).toBeNull();
  });
  it('isolates choices by visual and notifies other views without a provider request', () => {
    const event = vi.fn(); window.addEventListener(VISUALIZATION_STATE_EVENT, event);
    try {
      expect(writeVisualizationState('first', { variant: 'calm' })).toBe(true);
      expect(readVisualizationState('first')).toEqual({ variant: 'calm' });
      expect(readVisualizationState('second')).toEqual({});
      expect(event).toHaveBeenCalledTimes(1);
      expect(event.mock.calls[0][0].detail).toEqual({ id: 'first', state: { variant: 'calm' } });
      expect(writeVisualizationState('first', { tooLarge: 'x'.repeat(9000) })).toBe(false);
      expect(readVisualizationState('first')).toEqual({ variant: 'calm' });
    } finally { window.removeEventListener(VISUALIZATION_STATE_EVENT, event); }
  });
  it('recovers from malformed storage and denied storage access', () => {
    localStorage.setItem('o8:visualization-view:v1:broken', 'invalid');
    expect(readVisualizationState('broken')).toEqual({});
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Denied'); });
    expect(writeVisualizationState('blocked', {})).toBe(false);
  });
});
