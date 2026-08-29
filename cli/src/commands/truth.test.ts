import { afterEach, describe, expect, it } from 'vitest';

import { resolveConfig, resolveTruthConfig } from '../config';
import { CliError } from '../api';
import { parseTruthArguments, parseTruthSince } from './truth';

const NOW = Date.parse('2026-08-29T20:00:00.000Z');
const originalApiToken = process.env.O8_API_TOKEN;
const originalSpectatorToken = process.env.O8_SPECTATOR_TOKEN;
const originalWorkerToken = process.env.O8_WORKER_TOKEN;

afterEach(() => {
  if (originalApiToken === undefined) delete process.env.O8_API_TOKEN;
  else process.env.O8_API_TOKEN = originalApiToken;
  if (originalSpectatorToken === undefined) delete process.env.O8_SPECTATOR_TOKEN;
  else process.env.O8_SPECTATOR_TOKEN = originalSpectatorToken;
  if (originalWorkerToken === undefined) delete process.env.O8_WORKER_TOKEN;
  else process.env.O8_WORKER_TOKEN = originalWorkerToken;
});

describe('o8 truth argument parsing', () => {
  it('normalizes merged-since durations and ISO timestamps', () => {
    expect(parseTruthSince('24h', NOW)).toBe('2026-08-28T20:00:00.000Z');
    expect(parseTruthSince('2026-08-01T10:30:00Z', NOW)).toBe('2026-08-01T10:30:00.000Z');
    expect(parseTruthArguments('merged', [
      '--repo', 'example.test/team/repo-a',
      '--since', '7d',
      '--save-receipts', './receipts',
    ], NOW)).toEqual({
      query: {
        kind: 'merged-since',
        repo: 'example.test/team/repo-a',
        since: '2026-08-22T20:00:00.000Z',
      },
      saveReceiptsDir: './receipts',
    });
  });

  it('distinguishes a #issue from a packet id', () => {
    expect(parseTruthArguments('packet', ['#1998'], NOW).query)
      .toEqual({ kind: 'packet', issueNumber: 1998 });
    expect(parseTruthArguments('packet', ['packet-1998'], NOW).query)
      .toEqual({ kind: 'packet', packetId: 'packet-1998' });
  });

  it('parses approvals and rejects query-specific flags on the wrong shape', () => {
    expect(parseTruthArguments('approvals', ['packet-1998'], NOW).query)
      .toEqual({ kind: 'approvals', packetId: 'packet-1998' });
    expect(() => parseTruthArguments('approvals', ['packet-1998', '--repo', 'repo-a'], NOW))
      .toThrowError(CliError);
  });

  it('prefers the typed spectator token only for truth config', () => {
    delete process.env.O8_WORKER_TOKEN;
    process.env.O8_API_TOKEN = 'operator-token';
    process.env.O8_SPECTATOR_TOKEN = 'spectator-token';

    expect(resolveConfig()).toMatchObject({ token: 'operator-token', source: { token: 'env' } });
    expect(resolveTruthConfig()).toMatchObject({
      token: 'spectator-token',
      workerPacketId: null,
      source: { token: 'spectator' },
    });
  });
});
