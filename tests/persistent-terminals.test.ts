import { describe, expect, it, afterEach } from 'vitest';

import { persistentTerminalsEnabled } from '@/lib/terminal/tmux';

/**
 * #6 persistent / crash-survivable terminals — feature flag (default OFF).
 *
 * Gates whether interactive dash terminals spawn inside a tmux session (survive a
 * crash) vs the legacy ws-server-child PTY. Default OFF so terminal behavior is
 * byte-identical until the kill-test dogfood flips it ON (the #4 playbook).
 */
describe('#6 persistent terminals — feature flag (default OFF)', () => {
  const prior = process.env.O8_PERSISTENT_TERMINALS;
  afterEach(() => {
    if (prior === undefined) delete process.env.O8_PERSISTENT_TERMINALS;
    else process.env.O8_PERSISTENT_TERMINALS = prior;
  });

  it('is OFF when unset (terminals stay plain-shell until dogfood flips it)', () => {
    delete process.env.O8_PERSISTENT_TERMINALS;
    expect(persistentTerminalsEnabled()).toBe(false);
  });

  it('accepts 1 / true / on / yes (case-insensitive)', () => {
    for (const v of ['1', 'true', 'on', 'YES', ' On ']) {
      process.env.O8_PERSISTENT_TERMINALS = v;
      expect(persistentTerminalsEnabled()).toBe(true);
    }
  });

  it('treats 0 / false / empty / garbage as OFF', () => {
    for (const v of ['0', 'false', '', 'off', 'maybe']) {
      process.env.O8_PERSISTENT_TERMINALS = v;
      expect(persistentTerminalsEnabled()).toBe(false);
    }
  });
});
