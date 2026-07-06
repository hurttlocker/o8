import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { buildNode22ReexecPlan, findNode22Binary, NODE22_REEXEC_GUARD } from './operator-node22-locator';

function fakeNode(path: string, version: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `#!/bin/sh\necho ${version}\n`);
  chmodSync(path, 0o755);
}

describe('operator MCP Node 22 locator', () => {
  it('finds an nvm Node 22 binary under a temp HOME', () => {
    const homeDir = join(tmpdir(), `o8-node22-${process.pid}-${Date.now()}`);
    const nodePath = join(homeDir, '.nvm', 'versions', 'node', 'v22.1.0', 'bin', 'node');
    fakeNode(nodePath, 'v22.1.0');

    expect(findNode22Binary({ env: {}, homeDir })).toBe(nodePath);
  });

  it('never re-execs after the guard is set', () => {
    const plan = buildNode22ReexecPlan({
      currentNodeVersion: '24.1.0',
      env: { [NODE22_REEXEC_GUARD]: '1', O8_NODE_BIN: '/tmp/node22' },
      readVersion: () => 'v22.1.0',
      argv: ['server.mjs'],
      execArgv: [],
    });

    expect(plan).toEqual({ action: 'proceed', reason: 'guarded' });
  });

  it('builds the re-exec argv from execArgv followed by the current script argv', () => {
    const plan = buildNode22ReexecPlan({
      currentNodeVersion: '24.1.0',
      env: { O8_NODE_BIN: process.execPath },
      readVersion: () => 'v22.2.0',
      argv: ['operator-mcp-server.mjs', '--flag'],
      execArgv: ['--import=tsx'],
    });

    expect(plan).toEqual({
      action: 'reexec',
      nodePath: process.execPath,
      argv: ['--import=tsx', 'operator-mcp-server.mjs', '--flag'],
    });
  });
});
