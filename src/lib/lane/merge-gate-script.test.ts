import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
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

  it('actually runs from a directory that is not the repo', () => {
    // The point of the whole exercise: assertions on the generated STRING miss
    // any other syntax error, and this path is fail-closed, so an unrunnable
    // script blocks every merge. Execute it for real.
    const dir = mkdtempSync(path.join(tmpdir(), 'o8-gate-script-'));
    try {
      const file = path.join(dir, 'gate.mts');
      // Import the module, then exit before doing any gate work.
      const script = branchGateScript(process.cwd())
        .replace(/const lane = [\s\S]*?\n\}\)\(\)/, "process.stdout.write('RAN_OK');\n})()");
      writeFileSync(file, script, 'utf-8');
      const out = execFileSync('npx', ['--no-install', 'tsx', file], {
        cwd: process.cwd(),
        encoding: 'utf-8',
        timeout: 120_000,
        windowsHide: true,
      });
      expect(out).toContain('RAN_OK');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 150_000);
});
