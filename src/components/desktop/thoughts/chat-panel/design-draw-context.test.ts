import { describe, expect, it } from 'vitest';
import { parseDesignDrawContext } from './design-draw-context';

const NATIVE_TURN = [
  'can you make this say o8 operator here?',
  '',
  '[Design Mode drawing — 306×156 region at (11, 42)]',
  'Elements under the drawing:',
  '- <header> header — "o8 · fleet-level brain"',
  '- <h1> h1 — "The o8 Orchestrator — what I am and what I can do"',
  'Screenshot (full page): /Users/x/.o8/design-shots/draw-1.png',
  'Screenshot (drawn region crop): /Users/x/.o8/design-shots/draw-1-crop.png',
].join('\n');

describe('parseDesignDrawContext', () => {
  it('splits prompt from the context block', () => {
    const parsed = parseDesignDrawContext(NATIVE_TURN);
    expect(parsed).not.toBeNull();
    expect(parsed!.prompt).toBe('can you make this say o8 operator here?');
    expect(parsed!.regionLabel).toBe('306×156 region at (11, 42)');
    expect(parsed!.elementCount).toBe(2);
    expect(parsed!.detail.startsWith('[Design Mode drawing —')).toBe(true);
    expect(parsed!.detail).toContain('draw-1-crop.png');
  });

  it('handles the iframe path shape (page line, no screenshots)', () => {
    const parsed = parseDesignDrawContext(
      'fix this\n\n[Design Mode drawing — drawn region]\nPage: http://localhost:3000/\nElements under the drawing:\n- <p> p.lede — "hi"',
    );
    expect(parsed!.prompt).toBe('fix this');
    expect(parsed!.regionLabel).toBe('drawn region');
    expect(parsed!.elementCount).toBe(1);
  });

  it('returns null for ordinary user turns', () => {
    expect(parseDesignDrawContext('just a normal message')).toBeNull();
    expect(parseDesignDrawContext('')).toBeNull();
  });

  it('returns null when the marker never closes', () => {
    expect(parseDesignDrawContext('x [Design Mode drawing — broken')).toBeNull();
  });
});
