import { describe, expect, it } from 'vitest';

import { TERMINAL_LANE_STATUSES, isRefusedTerminalTransition } from './terminal-states';

describe('isRefusedTerminalTransition', () => {
  it('refuses re-opening a terminal lane (the #531 supervisor race)', () => {
    expect(isRefusedTerminalTransition('completed', 'awaiting_input')).toBe(true);
    expect(isRefusedTerminalTransition('completed', 'running')).toBe(true);
    expect(isRefusedTerminalTransition('failed', 'running')).toBe(true);
    expect(isRefusedTerminalTransition('archived', 'running')).toBe(true);
  });

  it('allows archiving from any terminal state', () => {
    expect(isRefusedTerminalTransition('completed', 'archived')).toBe(false);
    expect(isRefusedTerminalTransition('failed', 'archived')).toBe(false);
    expect(isRefusedTerminalTransition('archived', 'archived')).toBe(false);
  });

  it('allows idempotent same-status writes', () => {
    expect(isRefusedTerminalTransition('completed', 'completed')).toBe(false);
    expect(isRefusedTerminalTransition('failed', 'failed')).toBe(false);
  });

  it('never refuses transitions from non-terminal states', () => {
    expect(isRefusedTerminalTransition('running', 'completed')).toBe(false);
    expect(isRefusedTerminalTransition('awaiting_input', 'failed')).toBe(false);
    expect(isRefusedTerminalTransition('merging', 'running')).toBe(false);
  });

  it('terminal set stays exactly failed/completed/archived', () => {
    expect([...TERMINAL_LANE_STATUSES].sort()).toEqual(['archived', 'completed', 'failed']);
  });
});
