import { describe, it, expect } from 'vitest';
import {
  RESOLVED_UNKNOWNS_HEADING,
  buildFirstRunClarifyNote,
} from './clarify-first';

describe('clarify-first (silent, system-prompt-only since 2026-07-11)', () => {
  it('builds the first-mission note with the default-ambiguous framing and escape hatch', () => {
    const note = buildFirstRunClarifyNote();
    expect(note).toMatch(/first mission on this repo/i);
    expect(note).toMatch(/no dispatch history/i);
    expect(note).toMatch(/materially ambiguous by default/i);
    expect(note).toContain('skip, dispatch now');
    // Runs before any dispatch.
    expect(note).toMatch(/before the first create_mission\/dispatch/i);
  });

  it('keeps the Resolved unknowns heading contract workers depend on', () => {
    expect(RESOLVED_UNKNOWNS_HEADING).toBe('Resolved unknowns');
  });
});
