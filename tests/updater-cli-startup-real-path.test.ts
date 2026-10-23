import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, expect, it } from 'vitest';

beforeAll(() => {
  execFileSync(process.execPath, ['cli/esbuild.config.mjs'], { cwd: process.cwd(), stdio: 'pipe', timeout: 60_000 });
}, 65_000);

it.each(['--help', 'version'])('runs the fresh production CLI bundle: %s', command => {
  const result = spawnSync(process.execPath, ['cli/dist/o8.mjs', command], { cwd: process.cwd(), encoding: 'utf8', timeout: 15_000 });
  expect(result.status, result.stderr).toBe(0);
  const version = (JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { version: string }).version;
  if (command === '--help') expect(result.stdout.toLowerCase()).toContain('usage:');
  else expect(result.stdout).toContain(version);
  expect(result.stderr).not.toContain('server-only');
});
