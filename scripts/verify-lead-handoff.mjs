#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const result = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['vitest', 'run', 'tests/lead-handoff-real-path.test.ts'],
  {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: 'inherit',
    timeout: 120_000,
    env: { ...process.env, O8_OFFLINE_LEAD_PROBE: '1' },
  },
);

if (result.error) {
  const timeout = result.error.code === 'ETIMEDOUT';
  process.stderr.write(timeout
    ? 'lead handoff verification exceeded the 120-second bound.\n'
    : `lead handoff verification could not start: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
