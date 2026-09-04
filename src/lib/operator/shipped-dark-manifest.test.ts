import { describe, expect, it } from 'vitest';

import { OPERATOR_EXPERIMENTAL_OR_OPT_IN_FLAG_KEYS } from '@/lib/settings/toml';
import { OPERATOR_DEFAULTS_FALLBACK } from './defaults';
import {
  DEFAULT_SHIPPED_DARK_LIFECYCLE,
  isShippedDarkLifecycle,
  SHIPPED_DARK_FLAG_MANIFEST,
  shippedDarkManifestEntry,
} from './shipped-dark-manifest';

describe('shipped-dark installed manifest', () => {
  it('covers every settings-backed experimental or opt-in flag', () => {
    expect(Object.keys(SHIPPED_DARK_FLAG_MANIFEST).sort()).toEqual(
      [...OPERATOR_EXPERIMENTAL_OR_OPT_IN_FLAG_KEYS].map(String).sort(),
    );
  });

  it('records a release, a known lifecycle, and a rationale for every deliberate default-off flag', () => {
    for (const [key, entry] of Object.entries(SHIPPED_DARK_FLAG_MANIFEST)) {
      expect(entry.landedRelease, key).toMatch(/^\d+\.\d+\.\d+$/);
      expect(isShippedDarkLifecycle(entry.lifecycle), key).toBe(true);
      if (entry.lifecycle === 'deliberate-default-off') {
        expect(entry.rationale?.trim(), key).toBeTruthy();
      }
    }
  });

  it('only calls a flag promoted when its shipped code default is active', () => {
    for (const [key, entry] of Object.entries(SHIPPED_DARK_FLAG_MANIFEST)) {
      if (entry.lifecycle !== 'promoted') continue;
      const codeDefault = OPERATOR_DEFAULTS_FALLBACK[key as keyof typeof OPERATOR_DEFAULTS_FALLBACK];
      expect(codeDefault === false || codeDefault === 'off', key).toBe(false);
    }
  });

  it('treats an unrecorded flag as an unreviewed promotion candidate', () => {
    expect(shippedDarkManifestEntry('parallelCap')).toBeNull();
    expect(DEFAULT_SHIPPED_DARK_LIFECYCLE).toBe('promotion-candidate');
  });
});
