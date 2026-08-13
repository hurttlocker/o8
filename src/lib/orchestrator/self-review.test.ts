import { describe, expect, it } from 'vitest';

import {
  buildPacketSelfReviewInstructions,
  buildReadOnlyPacketSelfReviewInstructions,
  parsePacketSelfReview,
} from './self-review';

describe('packet self-review outcome receipt', () => {
  it('parses the outcome, evidence, residual, decision, and recurrence fields', () => {
    const review = parsePacketSelfReview(`
      <self-review>{
        "passed": true,
        "confidence": "high",
        "summary": "The route now reaches the guarded service.",
        "issuesFound": [],
        "outcome": "The user can complete the action through the production route.",
        "evidence": ["route test passed", "production prompt contains the kernel"],
        "residual": "none",
        "decision": "implementation_ready",
        "recurrenceProtection": "A real-path regression test covers the route."
      }</self-review>
    `);

    expect(review).toMatchObject({
      passed: true,
      outcome: 'The user can complete the action through the production route.',
      evidence: ['route test passed', 'production prompt contains the kernel'],
      residual: 'none',
      decision: 'implementation_ready',
      recurrenceProtection: 'A real-path regression test covers the route.',
    });
  });

  it('keeps legacy stored self-reviews readable', () => {
    expect(parsePacketSelfReview(
      '<self-review>{"passed":true,"confidence":"medium","summary":"Legacy receipt"}</self-review>',
    )).toMatchObject({ passed: true, confidence: 'medium', summary: 'Legacy receipt' });
  });

  it('rejects an unknown handoff decision', () => {
    expect(parsePacketSelfReview(
      '<self-review>{"passed":true,"confidence":"high","summary":"Bad","decision":"closed"}</self-review>',
    )).toBeNull();
  });

  it('rejects a handoff decision that contradicts the passed flag', () => {
    expect(parsePacketSelfReview(
      '<self-review>{"passed":true,"confidence":"high","summary":"Partial","decision":"partial"}</self-review>',
    )).toBeNull();
    expect(parsePacketSelfReview(
      '<self-review>{"passed":false,"confidence":"high","summary":"Ready","decision":"implementation_ready"}</self-review>',
    )).toBeNull();
  });

  it('teaches implementation readiness without letting the worker claim product closure', () => {
    const instructions = buildPacketSelfReviewInstructions().join('\n');
    expect(instructions).toContain('"outcome"');
    expect(instructions).toContain('"evidence"');
    expect(instructions).toContain('"residual"');
    expect(instructions).toContain('"decision"');
    expect(instructions).toContain('"recurrenceProtection"');
    expect(instructions).toContain('does not declare the user-facing outcome closed');
  });

  it('gives read-only packets a non-mutating finding receipt', () => {
    const instructions = buildReadOnlyPacketSelfReviewInstructions().join('\n');
    expect(instructions).toContain('"finding_ready|partial|blocked"');
    expect(instructions).toContain('at least one concrete evidence item');
    expect(instructions).toContain('does not permit edits, commits, mutations');
  });
});
