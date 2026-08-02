import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveConfig } from '../cli/src/config';

const ENV_KEYS = [
  'O8_API_PORT',
  'O8_API_TOKEN',
  'O8_WORKER_TOKEN',
  'O8_DATA_DIR',
  'CORTEX_IDE_DATA_DIR',
] as const;

let savedEnv: Record<string, string | undefined>;
let dataDir: string;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  dataDir = mkdtempSync(join(tmpdir(), 'o8-cli-config-isolation-'));
  delete process.env.O8_API_PORT;
  delete process.env.O8_API_TOKEN;
  delete process.env.O8_WORKER_TOKEN;
  delete process.env.O8_DATA_DIR;
  process.env.CORTEX_IDE_DATA_DIR = dataDir;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dataDir, { recursive: true, force: true });
});

describe('CLI data-dir isolation', () => {
  it('reads port and token files from CORTEX_IDE_DATA_DIR', () => {
    writeFileSync(join(dataDir, 'api-port'), '48123\n');
    writeFileSync(join(dataDir, 'ws-token'), 'isolated-token\n');

    expect(resolveConfig()).toMatchObject({
      apiPort: 48123,
      token: 'isolated-token',
      dataDir,
      source: { port: 'data-dir', token: 'data-dir' },
    });
  });

  it('fails closed instead of consulting global o8 or legacy state', () => {
    expect(resolveConfig()).toMatchObject({
      apiPort: 3001,
      token: null,
      dataDir,
      source: { port: 'default', token: 'none' },
    });
  });
});
