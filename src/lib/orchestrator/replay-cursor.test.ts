import { describe, it, expect } from 'vitest';
import { skipDuplicateBySeq } from './replay-cursor';

describe('skipDuplicateBySeq', () => {
  it('passes a fresh seq and advances the cursor', () => {
    const ref = { current: 0 };
    expect(skipDuplicateBySeq({ seq: 1 }, ref)).toBe(false);
    expect(ref.current).toBe(1);
    expect(skipDuplicateBySeq({ seq: 2 }, ref)).toBe(false);
    expect(ref.current).toBe(2);
  });

  it('skips a seq at or below the cursor without moving it', () => {
    const ref = { current: 5 };
    expect(skipDuplicateBySeq({ seq: 5 }, ref)).toBe(true); // exact dup
    expect(skipDuplicateBySeq({ seq: 3 }, ref)).toBe(true); // older replay
    expect(ref.current).toBe(5);
    expect(skipDuplicateBySeq({ seq: 6 }, ref)).toBe(false);
    expect(ref.current).toBe(6);
  });

  it('lets events without a numeric seq pass through and never moves the cursor', () => {
    const ref = { current: 9 };
    expect(skipDuplicateBySeq({}, ref)).toBe(false); // snapshot / notice
    expect(skipDuplicateBySeq({ seq: undefined }, ref)).toBe(false);
    expect(skipDuplicateBySeq({ seq: 'x' as unknown }, ref)).toBe(false);
    expect(ref.current).toBe(9);
  });
});
