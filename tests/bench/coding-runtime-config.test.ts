import { describe, expect, it } from 'vitest';

import {
  assertMatchingCodingRuntimeConfig,
  parseCodingRuntimeConfig,
} from '../../scripts/bench/coding-runtime-config';

const valid = {
  schema: 'o8/coding-runtime-config/v1',
  arms: {
    codex: { model: 'provider/codex-model', effort: 'high' },
    claude: { model: 'provider/claude-model', effort: 'max' },
  },
  judges: {
    codex: { model: 'provider/codex-judge', effort: 'medium' },
    claude: { model: 'provider/claude-judge', effort: 'high' },
  },
} as const;

describe('coding runtime config', () => {
  it('accepts one explicit model and manual effort for every arm runtime and judge', () => {
    expect(parseCodingRuntimeConfig(valid)).toEqual(valid);
  });

  it.each([
    [{ ...valid, arms: { ...valid.arms, codex: { ...valid.arms.codex, effort: 'adaptive' } } }],
    [{ ...valid, judges: { codex: valid.judges.codex } }],
    [{ ...valid, arms: { ...valid.arms, codex: { model: '--default', effort: 'high' } } }],
  ])('rejects incomplete or default-inheriting configuration', (input) => {
    expect(() => parseCodingRuntimeConfig(input)).toThrow('coding runtime config');
  });

  it('refuses to judge a legacy or differently configured collection', () => {
    const parsed = parseCodingRuntimeConfig(valid);
    expect(() => assertMatchingCodingRuntimeConfig(undefined, parsed)).toThrow('predates requested runtime settings');
    expect(() => assertMatchingCodingRuntimeConfig({
      ...valid,
      judges: { ...valid.judges, codex: { model: 'changed/judge', effort: 'medium' } },
    }, parsed)).toThrow('does not match');
  });
});
