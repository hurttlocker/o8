import { describe, expect, it } from 'vitest';

import { RelayReconnectPolicy } from './relay-reconnect';

describe('RelayReconnectPolicy', () => {
  it('jitters an infinite capped ladder and resets after a successful attach', () => {
    const policy = new RelayReconnectPolicy(1_000, 4_000, 8, () => 0);

    expect(policy.nextDelay()).toBe(500);
    expect(policy.nextDelay()).toBe(1_000);
    expect(policy.nextDelay()).toBe(2_000);
    for (let attempt = 0; attempt < 20; attempt++) {
      expect(policy.nextDelay()).toBe(2_000);
    }

    policy.reset();
    expect(policy.nextDelay()).toBe(500);
  });
});
