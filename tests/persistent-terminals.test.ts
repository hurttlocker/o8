import { describe, expect, it, afterEach } from 'vitest';

import { persistentTerminalsEnabled } from '@/lib/terminal/tmux';

/**
 * #6 persistent / crash-survivable terminals — feature flag (default ON since the
 * live kill-test passed on 0.1.513).
 *
 * Gates whether interactive dash terminals spawn inside a tmux session (survive a
 * crash) vs the legacy ws-server-child PTY. Default ON; only an explicit
 * 0/false/off/no opts out. (Machines without tmux fall back automatically in the
 * spawn helper, so default-ON is safe there too.)
 */
describe('#6 persistent terminals — feature flag (default ON)', () => {
  const prior = process.env.O8_PERSISTENT_TERMINALS;
  afterEach(() => {
    if (prior === undefined) delete process.env.O8_PERSISTENT_TERMINALS;
    else process.env.O8_PERSISTENT_TERMINALS = prior;
  });

  it('is ON when unset (persistence is the default)', () => {
    delete process.env.O8_PERSISTENT_TERMINALS;
    expect(persistentTerminalsEnabled()).toBe(true);
  });

  it('stays ON for 1 / true / on / yes and for unrelated values', () => {
    for (const v of ['1', 'true', 'on', 'YES', ' On ', '', 'maybe']) {
      process.env.O8_PERSISTENT_TERMINALS = v;
      expect(persistentTerminalsEnabled()).toBe(true);
    }
  });

  it('opts OUT only on an explicit 0 / false / off / no', () => {
    for (const v of ['0', 'false', 'off', 'NO', ' Off ']) {
      process.env.O8_PERSISTENT_TERMINALS = v;
      expect(persistentTerminalsEnabled()).toBe(false);
    }
  });
});
