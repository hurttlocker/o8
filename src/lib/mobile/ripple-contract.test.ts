import { describe, expect, it } from 'vitest';
import {
  formatRippleSystemContext,
  parseRippleResolutionDraft,
  parseRippleResolutionResult,
} from './ripple-contract';

describe('ripple contract', () => {
  it('accepts one bounded choice resolution', () => {
    expect(parseRippleResolutionDraft({
      kind: 'choice',
      question: 'What should be faster?',
      options: [
        { label: 'Input latency', value: 'input-latency' },
        { label: 'Animation', value: 'animation-duration' },
      ],
      aodlPath: 'constraints.latency',
      confidence: 0.8,
    })).toMatchObject({
      kind: 'choice',
      aodlPath: 'constraints.latency',
    });
  });

  it('rejects unbounded option sets and malformed AODL paths', () => {
    expect(parseRippleResolutionDraft({
      kind: 'choice',
      question: 'Pick one',
      options: Array.from({ length: 5 }, (_, index) => ({ label: String(index), value: String(index) })),
      aodlPath: 'constraints.latency',
    })).toBeNull();

    expect(parseRippleResolutionResult({
      kind: 'choice',
      id: 'r1',
      question: 'Pick one',
      options: [
        { label: 'A', value: 'a' },
        { label: 'B', value: 'b' },
      ],
      aodlPath: '../authority',
    })).toBeNull();
  });

  it('formats patches as resolved data without expanding authority', () => {
    const text = formatRippleSystemContext([{
      path: 'constraints.latency',
      value: 'input-latency',
      source: 'ripple',
      resolutionId: 'r1',
    }]);

    expect(text).toContain('do not expand authority');
    expect(text).toContain('constraints.latency = "input-latency"');
  });
});
