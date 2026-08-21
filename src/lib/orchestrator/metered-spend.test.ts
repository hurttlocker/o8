import { describe, expect, it } from 'vitest';

import { packetSpendCapBreach } from './metered-spend';

const cap = { carrier: 'openrouter' as const, costUsd: 1, inputTokens: 500_000 };

describe('packetSpendCapBreach', () => {
  it('uses authoritative cost when available and input tokens only as the unknown-cost fallback', () => {
    expect(packetSpendCapBreach(cap, { costUsd: 1, inputTokens: 1 })).toBe('cost');
    expect(packetSpendCapBreach(cap, { costUsd: 0, inputTokens: 900_000 })).toBeNull();
    expect(packetSpendCapBreach(cap, { costUsd: null, inputTokens: 500_000 })).toBe('input_tokens');
  });
});
