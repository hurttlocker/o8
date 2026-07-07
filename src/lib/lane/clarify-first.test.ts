import { describe, it, expect } from 'vitest';
import {
  CLARIFY_DIRECTIVE_HEADING,
  RESOLVED_UNKNOWNS_HEADING,
  buildClarifyDirectiveBlock,
  prependClarifyDirective,
} from './clarify-first';

describe('clarify-first directive', () => {
  it('codifies the interview shape in the directive block', () => {
    const block = buildClarifyDirectiveBlock();
    expect(block).toContain(CLARIFY_DIRECTIVE_HEADING);
    // One-question-at-a-time, ordered by blast radius.
    expect(block).toContain('ONE question at a time');
    expect(block).toMatch(/blast radius/i);
    expect(block).toMatch(/data model >.*type\/interface.*>.*UX flow.*>.*mechanical/i);
    // The escape hatch and the ~5 cap.
    expect(block).toContain('skip, dispatch now');
    expect(block).toMatch(/~5/);
    // Resolved Q&A must land under the heading workers read.
    expect(block).toContain(RESOLVED_UNKNOWNS_HEADING);
    // Runs before any dispatch.
    expect(block).toMatch(/before you create_mission/i);
  });

  it('prepends the directive ahead of the verbatim operator message', () => {
    const message = 'Add a favorites feature to the dashboard';
    const out = prependClarifyDirective(message);
    expect(out.startsWith(CLARIFY_DIRECTIVE_HEADING)).toBe(true);
    expect(out.endsWith(message)).toBe(true);
    // The operator's text survives untouched, after the block.
    expect(out.indexOf(message)).toBeGreaterThan(out.indexOf(CLARIFY_DIRECTIVE_HEADING));
    expect(out).toContain(`\n\n${message}`);
  });
});
