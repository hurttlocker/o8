import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  canonicalizeServerOnlyStubEnv,
  canonicalizeServerOnlyStubNodeOptions,
  SERVER_ONLY_STUB_NODE_OPTION,
  withServerOnlyStubNodeOptions,
} from '../scripts/run-lib.mjs';

const runScript = fileURLToPath(new URL('../scripts/run.mjs', import.meta.url));
const legacyServerOnlyStubNodeOption = '--import=./scripts/register-server-only-stub.mjs';

describe('server-only stub node options', () => {
  it('canonicalizes the stub without changing unrelated options', () => {
    expect(canonicalizeServerOnlyStubNodeOptions('--trace-warnings')).toBe('--trace-warnings');
    expect(withServerOnlyStubNodeOptions(
      `--trace-warnings ${legacyServerOnlyStubNodeOption} ${SERVER_ONLY_STUB_NODE_OPTION}`,
    )).toBe(`--trace-warnings ${SERVER_ONLY_STUB_NODE_OPTION}`);
  });

  it('starts a Node child outside the repository through the package script runner', () => {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const result = spawnSync(process.execPath, [
      runScript,
      `NODE_OPTIONS=${legacyServerOnlyStubNodeOption}`,
      '--',
      'tsx',
      '--eval',
      "require('server-only')",
    ], {
      cwd: os.tmpdir(),
      env,
      encoding: 'utf8',
    });

    expect(result.status, result.error?.message ?? result.stderr).toBe(0);
  });

  it('keeps the inherited preload valid after a release child changes into cli', () => {
    const env = canonicalizeServerOnlyStubEnv({
      ...process.env,
      NODE_OPTIONS: legacyServerOnlyStubNodeOption,
    });
    const result = spawnSync(process.execPath, [
      '--eval',
      "require('server-only')",
    ], {
      cwd: fileURLToPath(new URL('../cli', import.meta.url)),
      env,
      encoding: 'utf8',
    });

    expect(result.status, result.error?.message ?? result.stderr).toBe(0);
    expect(env.NODE_OPTIONS).toBe(SERVER_ONLY_STUB_NODE_OPTION);
  });
});
