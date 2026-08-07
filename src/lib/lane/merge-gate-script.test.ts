import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { branchGateScript } from './merge-gate';

/**
 * The branch merge gate runs in a subprocess and is FAIL-CLOSED: if its script
 * cannot load the gate module, every packet touching this file is blocked.
 *
 * That script moved from an `--eval` argument into a temp file, and its import
 * specifier was relative — which resolves against the process cwd for --eval
 * but against the SCRIPT's directory in a file. The regression was invisible
 * because nothing drove this path. These assert the property that broke.
 */
describe('branch merge gate script', () => {
  it('resolves the gate module absolutely, not relative to wherever the script lands', () => {
    const script = branchGateScript('/some/worktree');
    expect(script).not.toContain("'./src/lib/lane/merge-gate.ts'");
    expect(script).toContain(pathToFileURL(path.join('/some/worktree', 'src', 'lib', 'lane', 'merge-gate.ts')).href);
  });

  it('emits a file:// URL, the only specifier form Windows accepts', () => {
    // A bare C:\... path is not a valid ESM specifier.
    const script = branchGateScript('/repo');
    const match = /await import\("([^"]+)"\)/.exec(script);
    expect(match?.[1]?.startsWith('file://')).toBe(true);
  });

  it('stays loadable from a directory that is not the repo', () => {
    // The exact shape of the regression: written to a temp dir, run from there.
    const dir = mkdtempSync(path.join(tmpdir(), 'o8-gate-script-'));
    try {
      const file = path.join(dir, 'gate.mts');
      writeFileSync(file, branchGateScript(process.cwd()), 'utf-8');
      const specifier = /await import\("([^"]+)"\)/.exec(branchGateScript(process.cwd()))?.[1];
      expect(specifier).toBeTruthy();
      // Resolvable without reference to the script's own location.
      expect(specifier!).toBe(
        pathToFileURL(path.join(process.cwd(), 'src', 'lib', 'lane', 'merge-gate.ts')).href,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
