import { describe, expect, it } from 'vitest';

import { parseMissionCandidateMode } from './quality-search-input';

const taskContract = {
  version: 1,
  requirements: [{
    id: 'R1',
    source: 'Do the thing.',
    expectedBehavior: 'The thing works.',
    productionPath: 'entry -> implementation',
    verification: 'focused test',
  }],
  smallestRoute: [{
    path: 'src/implementation.ts',
    requirements: ['R1'],
    reason: 'The implementation owns the behavior.',
  }],
  exclusions: [],
};

describe('mission candidate-mode input', () => {
  it('accepts one valid sealed contract', () => {
    const result = parseMissionCandidateMode({ qualitySearch: { taskContract } }, undefined);
    expect(result).toEqual({
      ok: true,
      comparisonModels: undefined,
      qualitySearch: { taskContract },
    });
  });

  it('rejects combinations that would create an ambiguous fan-out', () => {
    expect(parseMissionCandidateMode({
      comparisonModels: ['model-a', 'model-b'],
      qualitySearch: { taskContract },
    }, false)).toEqual({ ok: false, error: 'qualitySearch cannot be combined with comparisonModels.' });
    expect(parseMissionCandidateMode({ qualitySearch: { taskContract } }, true)).toEqual({
      ok: false,
      error: 'qualitySearch already uses a sealed contract and cannot be combined with huddle mode.',
    });
    expect(parseMissionCandidateMode({
      qualitySearch: { taskContract },
      taskContract: 'off',
    }, false)).toEqual({
      ok: false,
      error: 'qualitySearch already uses a sealed contract and cannot be combined with taskContract: "off".',
    });
  });
});
