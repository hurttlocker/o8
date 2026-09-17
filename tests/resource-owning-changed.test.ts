import { describe, expect, it } from 'vitest';
import { parseNameStatus, selectResourceOwning } from '../scripts/ci/resource-owning-changed.mjs';

const classification = {
  resourceOwning: [
    { path: 'tests/packet-merge-real-path.test.ts' },
    { path: 'src/lib/lane/merge-lock.test.ts' },
  ],
};

function nameStatus(...records: string[][]): string {
  return records.map((record) => `${record.join('\0')}\0`).join('');
}

describe('resource-owning-changed', () => {
  it('selects nothing when the diff is empty', () => {
    expect(selectResourceOwning(parseNameStatus(''), classification)).toEqual([]);
  });

  it('selects a touched resource-owning test', () => {
    const output = nameStatus(
      ['M', 'src/lib/lane/merge.ts'],
      ['M', 'tests/packet-merge-real-path.test.ts'],
    );
    expect(selectResourceOwning(parseNameStatus(output), classification)).toEqual([
      'tests/packet-merge-real-path.test.ts',
    ]);
  });

  it('excludes a touched hermetic test', () => {
    const output = nameStatus(['A', 'tests/theme-registry.test.ts'], ['M', 'src/lib/theme/registry.ts']);
    expect(selectResourceOwning(parseNameStatus(output), classification)).toEqual([]);
  });

  it('follows a rename to the new path and drops deleted files', () => {
    const output = nameStatus(
      ['R087', 'src/lib/lane/old-merge-lock.test.ts', 'src/lib/lane/merge-lock.test.ts'],
      ['D', 'tests/packet-merge-real-path.test.ts'],
    );
    expect(parseNameStatus(output)).toEqual(['src/lib/lane/merge-lock.test.ts']);
    expect(selectResourceOwning(parseNameStatus(output), classification)).toEqual([
      'src/lib/lane/merge-lock.test.ts',
    ]);
  });
});
