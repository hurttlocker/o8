import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// The heap bound is applied by the registered build step, which the production
// build runs once generated-output ownership is reserved (#3457).
const REGISTERED_BUILD = pathToFileURL(resolve('scripts/lib/registered-build.mjs')).href;

function runBuild(heap?: string) {
  const root = mkdtempSync(join(tmpdir(), 'o8-build-heap-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'next', 'dist', 'bin'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"name":"fixture","version":"0.0.0"}');
  writeFileSync(join(root, 'scripts', 'bust-stale-patch-cache.mjs'), '');
  writeFileSync(join(root, 'node_modules', 'next', 'package.json'), '{"name":"next","version":"0.0.0"}');
  writeFileSync(join(root, 'node_modules', 'next', 'dist', 'bin', 'next.js'),
    "require('node:fs').writeFileSync('observed.json', JSON.stringify({ options: process.env.NODE_OPTIONS, args: process.argv.slice(2), production: process.env.NODE_ENV }));");
  writeFileSync(join(root, 'harness.mjs'), [
    "import { spawnSync } from 'node:child_process';",
    `import { runRegisteredBuild } from ${JSON.stringify(REGISTERED_BUILD)};`,
    'process.exitCode = await runRegisteredBuild((command, args, env) =>',
    "  spawnSync(command, args, { env: env ?? process.env, stdio: 'inherit' }).status ?? 1);",
  ].join('\n'));
  const env = { ...process.env };
  delete env.O8_BUILD_HEAP_MIB;
  delete env.NODE_OPTIONS;
  if (heap !== undefined) env.O8_BUILD_HEAP_MIB = heap;
  const result = spawnSync(process.execPath, ['harness.mjs'], { cwd: root, env, encoding: 'utf8' });
  const observed = existsSync(join(root, 'observed.json'))
    ? JSON.parse(readFileSync(join(root, 'observed.json'), 'utf8'))
    : null;
  rmSync(root, { recursive: true, force: true });
  return { result, observed };
}

describe('production build heap limit', () => {
  it('passes the bounded host heap to the real build child', () => {
    const { result, observed } = runBuild('8192');
    expect(result.status, result.stderr).toBe(0);
    expect(observed).toEqual({ options: '--max-old-space-size=8192', args: ['build', '--webpack'], production: 'production' });
  });

  it('preserves the default local build heap', () => {
    const { result, observed } = runBuild();
    expect(result.status, result.stderr).toBe(0);
    expect(observed.options).toBe('--max-old-space-size=24576');
  });

  it.each(['0', '1023', '24577', '8192.5', 'oops', ''])('rejects invalid heap %j before launching the compiler', (heap) => {
    const { result, observed } = runBuild(heap);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('O8_BUILD_HEAP_MIB');
    expect(observed).toBeNull();
  });
});
