/** @vitest-environment jsdom */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, it, expect } from 'vitest';
import { nextRevealIndex, useSmoothText } from './use-smooth-text';

function SmoothTextHarness({ text, streaming }: { text: string; streaming: boolean }) {
  return createElement('div', null, useSmoothText(text, streaming));
}

describe('nextRevealIndex (smooth streaming reveal stepping)', () => {
  it('returns the length when already caught up', () => {
    expect(nextRevealIndex(10, 'hello')).toBe(5);
    expect(nextRevealIndex(5, 'hello')).toBe(5);
  });

  it('advances toward the target and is monotonic', () => {
    const text = 'one two three four five six seven eight nine ten';
    let i = 0;
    let last = -1;
    const steps: number[] = [];
    while (i < text.length) {
      i = nextRevealIndex(i, text);
      expect(i).toBeGreaterThan(last);
      steps.push(i);
      last = i;
    }
    expect(i).toBe(text.length); // always converges exactly to the end
    expect(steps.length).toBeGreaterThan(1); // revealed over multiple frames, not one jump
  });

  it('snaps to a whitespace boundary so words are never split mid-word', () => {
    const text = 'alpha bravo charlie delta echo foxtrot';
    let i = 0;
    while (i < text.length) {
      const next = nextRevealIndex(i, text);
      // the revealed slice ends either at the very end or on whitespace
      if (next < text.length) {
        expect(/\s/.test(text[next]!)).toBe(true);
      }
      i = next;
    }
  });

  it('reveals a big burst over several frames (smooth, not instant)', () => {
    // realistic spaced prose ~2KB (a whole paragraph arriving in one event)
    const text = Array.from({ length: 320 }, (_, i) => `word${i}`).join(' ');
    let i = 0;
    let frames = 0;
    while (i < text.length && frames < 1000) { i = nextRevealIndex(i, text); frames += 1; }
    expect(i).toBe(text.length);
    expect(frames).toBeGreaterThan(8); // paced out, not dumped in one frame
    expect(frames).toBeLessThan(200); // but bounded — doesn't crawl forever
  });

  it('does not dump a giant unbroken token in a single frame', () => {
    const text = 'y'.repeat(2000); // e.g. a base64 blob with no whitespace
    expect(nextRevealIndex(0, text)).toBeLessThan(text.length);
  });

  it('never bursts more than ~30 chars in one frame, even draining a huge backlog', () => {
    // Regression: a whole reply arriving as one chunk used to drain with a
    // front-loaded spike (185, 145, 115 chars/frame) — the "shoots in" jolt.
    // The per-frame advance must stay bounded so it flows in steadily.
    const text = Array.from({ length: 600 }, (_, i) => `word${i}`).join(' '); // ~4KB at once
    let i = 0;
    let maxDelta = 0;
    let frames = 0;
    while (i < text.length && frames < 4000) {
      const next = nextRevealIndex(i, text);
      maxDelta = Math.max(maxDelta, next - i);
      i = next;
      frames += 1;
    }
    expect(i).toBe(text.length);
    // 32 step cap + 10 word-snap = 42 hard ceiling; fast, but never the
    // 100+-char single-frame dump that reads as "shooting in".
    expect(maxDelta).toBeLessThanOrEqual(42);
  });

  it('always moves by at least the minimum step on a slow trickle', () => {
    const text = 'abcdefghij';
    expect(nextRevealIndex(0, text)).toBeGreaterThanOrEqual(2);
  });

  it('shows late text immediately when the message never streamed', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const text = 'x'.repeat(200);

    act(() => root.render(createElement(SmoothTextHarness, { text: '', streaming: false })));
    act(() => root.render(createElement(SmoothTextHarness, { text, streaming: false })));

    expect(container.textContent).toBe(text);
    act(() => root.unmount());
  });
});
