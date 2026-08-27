import { describe, expect, it } from 'vitest';

import { OPERATOR_EXPERIMENTAL_OR_OPT_IN_FLAG_KEYS } from '@/lib/settings/toml';
import { SHIPPED_DARK_FLAG_LANDING_RELEASES } from './shipped-dark-manifest';

describe('shipped-dark installed manifest', () => {
  it('covers every settings-backed experimental or opt-in flag', () => {
    expect(Object.keys(SHIPPED_DARK_FLAG_LANDING_RELEASES).sort()).toEqual(
      [...OPERATOR_EXPERIMENTAL_OR_OPT_IN_FLAG_KEYS].map(String).sort(),
    );
  });
});
