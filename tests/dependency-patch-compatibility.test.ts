import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const trace: (files: string[], options: unknown) => Promise<{
  fileList: Set<string>;
  warnings: Set<Error>;
}> = require('next/dist/compiled/@vercel/nft').nodeFileTrace;

describe('installed dependency compatibility patches', () => {
  it('keeps the framework patches applied after a dependency update', () => {
    const traceSource = readFileSync(require.resolve('next/dist/compiled/@vercel/nft'), 'utf8');
    const actionSource = readFileSync(
      require.resolve('next/dist/build/webpack/plugins/flight-client-entry-plugin'),
      'utf8',
    );

    expect(traceSource).toContain('[o8-port] skipping out-of-base trace glob');
    expect(actionSource).toContain('__o8LookupActionModule(pluginState.serverActionModules, name)');
    expect(actionSource).toContain('__o8LookupActionModule(pluginState.edgeServerActionModules, name)');
  });

  it.each([
    ['inside', 'assets/keep.txt', true],
    ['outside', '../outside/skip.txt', false],
  ] as const)('traces %s assets through the installed entry point', async (_, relativeAsset, included) => {
    // Supply a virtual filesystem to the real tracer. No app state or on-disk
    // fixture is read, and plain file references do not start directory globs.
    const base = path.resolve('virtual-dependency-trace');
    const entry = path.join(base, 'entry.cjs');
    const asset = path.resolve(base, relativeAsset);
    const result = await trace([entry], {
      base,
      processCwd: base,
      readFile: async (file: string) => file === entry
        ? `require('fs').readFileSync(${JSON.stringify(asset)});`
        : file === asset ? 'fixture data' : null,
      readlink: async () => null,
      stat: async (file: string) => file === entry || file === asset
        ? { isFile: () => true, isDirectory: () => false }
        : null,
    });

    expect(result.warnings.size).toBe(0);
    expect(result.fileList.has('entry.cjs')).toBe(true);
    expect(result.fileList.has(path.relative(base, asset))).toBe(included);
  });
});
