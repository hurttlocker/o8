import { describe, expect, it } from 'vitest';

import { parseLsofPids, parseNetstatPids } from '../scripts/kill-port.mjs';
import { parseEnvPrefixArgv } from '../scripts/run-lib.mjs';

// #1744: these helpers replaced POSIX-shell one-liners in package.json. The
// Windows halves cannot be exercised on macOS/CI any other way, so the parsing
// is pure and tested against captured tool output.

describe('kill-port pid parsing', () => {
  it('reads one pid per line from lsof -ti, deduped', () => {
    expect(parseLsofPids('4821\n4821\n5093\n')).toEqual([4821, 5093]);
  });

  it('returns nothing when lsof matched nothing', () => {
    expect(parseLsofPids('')).toEqual([]);
  });

  it('picks listening pids for the port out of netstat -ano -p tcp', () => {
    const stdout = [
      'Active Connections',
      '',
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    0.0.0.0:3010           0.0.0.0:0              LISTENING       4821',
      '  TCP    [::]:3010              [::]:0                 LISTENING       4821',
      '  TCP    0.0.0.0:3011           0.0.0.0:0              LISTENING       5093',
      '  TCP    127.0.0.1:3010         127.0.0.1:52001        ESTABLISHED     7777',
      '  TCP    0.0.0.0:13010          0.0.0.0:0              LISTENING       8888',
    ].join('\n');
    expect(parseNetstatPids(stdout, 3010)).toEqual([4821]);
    expect(parseNetstatPids(stdout, 3011)).toEqual([5093]);
  });

  it('matches listeners on localized Windows, where the state column is translated', () => {
    const stdout = '  TCP    0.0.0.0:3010           0.0.0.0:0              ABHOEREN        4821';
    expect(parseNetstatPids(stdout, 3010)).toEqual([4821]);
  });
});

describe('env-prefix argv parsing', () => {
  it('splits assignments from the command at the -- separator', () => {
    expect(parseEnvPrefixArgv(['PORT=3010', '--', 'next', 'dev', '-p', '3010'])).toEqual({
      assignments: { PORT: '3010' },
      command: 'next',
      args: ['dev', '-p', '3010'],
    });
  });

  it('keeps = inside a value, so NODE_OPTIONS survives intact', () => {
    const parsed = parseEnvPrefixArgv([
      'NODE_OPTIONS=--import=./scripts/register-server-only-stub.mjs',
      '--',
      'tsx',
      'src/ws-server.ts',
    ]);
    expect(parsed.assignments).toEqual({
      NODE_OPTIONS: '--import=./scripts/register-server-only-stub.mjs',
    });
    expect(parsed.command).toBe('tsx');
    expect(parsed.args).toEqual(['src/ws-server.ts']);
  });
});
