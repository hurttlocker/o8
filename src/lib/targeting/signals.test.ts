/**
 * Targeting signals — the pure pieces (parse + join). The DB/git-touching
 * `collectSignals` / `computeGitChurn` wrappers are exercised via the API smoke.
 */

import { describe, it, expect } from 'vitest';

import { joinSignals, parseGitChurn, type TargetSignals } from './signals';
import type { FileSkeleton } from '@/lib/skeleton/types';

describe('parseGitChurn', () => {
  it('tallies a path once per commit it appears in', () => {
    // Two commits (blank-line separated); a.ts touched in both, b.ts in one.
    const output = ['a.ts', 'b.ts', '', 'a.ts', ''].join('\n');
    const churn = parseGitChurn(output);
    expect(churn.get('a.ts')).toBe(2);
    expect(churn.get('b.ts')).toBe(1);
  });

  it('ignores blank lines and whitespace; empty → empty', () => {
    expect(parseGitChurn('').size).toBe(0);
    expect(parseGitChurn('\n\n  \n').size).toBe(0);
  });
});

describe('joinSignals', () => {
  const skel = (path: string, loc: number, symbols: number, imports: number): FileSkeleton => ({
    relativePath: path,
    language: 'typescript',
    symbols: Array.from({ length: symbols }, (_, i) => ({ name: `s${i}` })) as FileSkeleton['symbols'],
    imports: Array.from({ length: imports }, (_, i) => `./dep${i}`),
    lineCount: loc,
    contentHash: 'h',
  });

  it('maps skeleton fields + looks up inbound/churn (default 0)', () => {
    const skeletons = [skel('src/core.ts', 400, 12, 8), skel('src/leaf.ts', 40, 2, 1)];
    const inbound = new Map([['src/core.ts', 15]]); // leaf absent → 0
    const churn = new Map([['src/core.ts', 6]]);

    const rows = joinSignals(skeletons, inbound, churn);
    const core = rows.find((r) => r.path === 'src/core.ts')!;
    const leaf = rows.find((r) => r.path === 'src/leaf.ts')!;

    expect(core).toMatchObject<Partial<TargetSignals>>({ loc: 400, symbolCount: 12, outboundImports: 8, inbound: 15, churn: 6 });
    expect(leaf).toMatchObject<Partial<TargetSignals>>({ loc: 40, symbolCount: 2, outboundImports: 1, inbound: 0, churn: 0 });
  });

  it('emits exactly one row per cached file (only skeleton-cached files scored)', () => {
    const rows = joinSignals([skel('a.ts', 1, 0, 0)], new Map(), new Map());
    expect(rows).toHaveLength(1);
    expect(rows[0].path).toBe('a.ts');
  });
});
