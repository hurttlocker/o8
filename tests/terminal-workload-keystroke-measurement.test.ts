import { describe, expect, it } from 'vitest';
// @ts-expect-error -- the benchmark classifier is intentionally native ESM without generated declarations.
import { classifyKeystrokeTimeout } from '../scripts/bench/terminal-workload/keystroke-measurement.mjs';

describe('terminal workload keystroke timeout classification', () => {
  it('distinguishes a painted marker missed by the polling window', () => {
    expect(classifyKeystrokeTimeout({
      auxDeliveredAt: 100,
      panelDeliveredAt: 102,
      panelPaintedAt: 105,
    })).toBe('painted-but-missed');
  });

  it('distinguishes delivery without a painted frame', () => {
    expect(classifyKeystrokeTimeout({
      auxDeliveredAt: 100,
      panelDeliveredAt: null,
      panelPaintedAt: null,
    })).toBe('delivered-not-painted');
  });

  it('distinguishes a marker that never reached either delivery path', () => {
    expect(classifyKeystrokeTimeout({
      auxDeliveredAt: null,
      panelDeliveredAt: null,
      panelPaintedAt: null,
    })).toBe('not-delivered');
  });
});
