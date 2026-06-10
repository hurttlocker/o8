import { describe, expect, it } from 'vitest';

import { compareCliVersions } from './cli-resolver';

describe('compareCliVersions', () => {
  it('orders plain semver correctly', () => {
    expect(compareCliVersions('0.130.0', '0.129.9')).toBeGreaterThan(0);
    expect(compareCliVersions('0.129.9', '0.130.0')).toBeLessThan(0);
    expect(compareCliVersions('1.0.0', '0.999.999')).toBeGreaterThan(0);
    expect(compareCliVersions('0.130.0', '0.130.0')).toBe(0);
  });

  it('compares numerically, not lexically (0.9 < 0.130)', () => {
    expect(compareCliVersions('0.9.0', '0.130.0')).toBeLessThan(0);
  });

  it('treats missing segments as zero', () => {
    expect(compareCliVersions('1.2', '1.2.0')).toBe(0);
    expect(compareCliVersions('1.2', '1.2.1')).toBeLessThan(0);
  });

  it('treats non-numeric segments as zero instead of throwing', () => {
    expect(compareCliVersions('1.x.0', '1.0.0')).toBe(0);
    expect(compareCliVersions('garbage', '0.0.1')).toBeLessThan(0);
  });
});
