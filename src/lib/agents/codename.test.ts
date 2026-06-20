import { describe, it, expect } from 'vitest';
import { codename, codenamePool, runtimeColor } from './codename';

describe('codename', () => {
  it('is deterministic for a given seed', () => {
    // The contract Slice 2 leans on: the card label (client) and voice resolution
    // (server) call this same function, so a seed must always yield one name.
    const seed = 'worktree:packet-abc123';
    expect(codename(seed)).toBe(codename(seed));
  });

  it('only ever returns names from the pool', () => {
    const pool = new Set(codenamePool());
    for (let i = 0; i < 500; i += 1) {
      expect(pool.has(codename(`lane-${i}`))).toBe(true);
    }
  });

  it('spreads different seeds across multiple names', () => {
    const names = new Set(Array.from({ length: 50 }, (_, i) => codename(`lane-${i}`)));
    // Not all 50 collapse to one name — voice addressing would be useless if they did.
    expect(names.size).toBeGreaterThan(1);
  });

  it('maps each worker runtime to a distinct accent and falls back to a token', () => {
    expect(runtimeColor('codex')).toBe('#2563eb');
    expect(runtimeColor('claude-code')).toBe('#e07a3a');
    expect(runtimeColor('gemini')).toBe('#4285f4');
    expect(runtimeColor('opencode')).toBe('#a855f7');
    expect(runtimeColor(null)).toBe('var(--cnv-ink-muted)');
    expect(runtimeColor('something-else')).toBe('var(--cnv-ink-muted)');
  });
});
