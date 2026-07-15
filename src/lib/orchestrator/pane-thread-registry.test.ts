import { describe, it, expect, afterEach } from 'vitest';
import {
  registerPaneThread,
  unregisterPaneThread,
  isPaneOwnedThread,
} from './pane-thread-registry';

// Adversarial review 2026-07-15: the registry was a plain Set, so the same
// thread open in TWO panes recorded one entry — closing either pane deleted it
// and disabled the ingest guard for the pane still mounted. Ownership must be
// reference-counted: owned until the LAST pane unregisters.

describe('pane-thread-registry — reference-counted ownership', () => {
  afterEach(() => {
    // Drain any leftover counts so cases don't bleed into each other.
    for (let i = 0; i < 8; i++) {
      unregisterPaneThread('t');
      unregisterPaneThread('u');
    }
  });

  it('a single register/unregister owns then releases', () => {
    expect(isPaneOwnedThread('t')).toBe(false);
    registerPaneThread('t');
    expect(isPaneOwnedThread('t')).toBe(true);
    unregisterPaneThread('t');
    expect(isPaneOwnedThread('t')).toBe(false);
  });

  it('stays owned after ONE of two panes closes (the Set-bug repro)', () => {
    registerPaneThread('t');
    registerPaneThread('t');
    expect(isPaneOwnedThread('t')).toBe(true);
    unregisterPaneThread('t'); // one pane closes
    expect(isPaneOwnedThread('t')).toBe(true); // the other pane still owns it
    unregisterPaneThread('t'); // last pane closes
    expect(isPaneOwnedThread('t')).toBe(false);
  });

  it('never goes negative — an extra unregister cannot resurrect ownership', () => {
    registerPaneThread('u');
    unregisterPaneThread('u');
    unregisterPaneThread('u'); // spurious
    expect(isPaneOwnedThread('u')).toBe(false);
    registerPaneThread('u');
    expect(isPaneOwnedThread('u')).toBe(true); // count started clean at 1, not -1
  });
});
