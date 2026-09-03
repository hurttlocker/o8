import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CliError, EXIT } from '../cli/src/api';
import { parseMissionStopArgs, runMission } from '../cli/src/commands/mission';
import { parsePacketStopArgs } from '../cli/src/commands/packet/stop';
import { managedRunEnvironmentLines, parseRunStopArgs } from '../cli/src/commands/run';
import {
  initializeManagedRunReceipt,
  readLastManagedRunReceipt,
} from '../cli/src/commands/run-receipts';

const receiptRoots: string[] = [];

describe('CLI stop command parsing', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    while (receiptRoots.length > 0) rmSync(receiptRoots.pop()!, { recursive: true, force: true });
  });

  it('packet stop treats positional and --packet ids identically', () => {
    expect(parsePacketStopArgs(['pkt-target'])).toEqual({ packetId: 'pkt-target' });
    expect(parsePacketStopArgs(['--packet', 'pkt-target'])).toEqual({ packetId: 'pkt-target' });
  });

  it('packet stop rejects unknown extra positional args', () => {
    expect(() => parsePacketStopArgs(['pkt-1', 'extra'])).toThrow(CliError);
  });

  it('mission stop requires --mission', () => {
    expect(parseMissionStopArgs(['--mission', 'mission-1'])).toEqual({
      missionId: 'mission-1',
    });
    expect(parseMissionStopArgs([
      '--mission',
      'mission-1',
      '--idempotency-key',
      'mission-stop-key',
    ])).toEqual({
      missionId: 'mission-1',
      idempotencyKey: 'mission-stop-key',
    });
    expect(() => parseMissionStopArgs([])).toThrow(CliError);
  });

  it('mission stop polls the exact body through an accepted receipt', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        result: { inProgress: true, status: 'in_progress' },
      }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        result: { missionId: 'mission-1', packets: [] },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const request = runMission(
      { human: false, verbose: false },
      'stop',
      ['--mission', 'mission-1', '--idempotency-key', 'mission-stop-key'],
    );
    await vi.runAllTimersAsync();
    await expect(request).resolves.toBe(0);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const requestBodies = fetchMock.mock.calls.map(([, init]) => String((init as RequestInit).body));
    expect(requestBodies[1]).toBe(requestBodies[0]);
    expect(JSON.parse(requestBodies[0])).toEqual({
      missionId: 'mission-1',
      idempotencyKey: 'mission-stop-key',
    });
    vi.useRealTimers();
  });

  it('mission stop exits with a conflict when any packet was not stopped', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      error: {
        code: 'mission_stop_incomplete',
        message: 'Mission stop was incomplete: 1 packet could not be stopped.',
      },
    }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    })));

    await expect(runMission(
      { human: false, verbose: false },
      'stop',
      ['--mission', 'mission-partial-stop'],
    )).rejects.toMatchObject({
      constructor: CliError,
      exit: EXIT.CONFLICT,
      message: expect.stringContaining('Mission stop was incomplete'),
    });
  });

  it('run stop requires exactly one run id', () => {
    expect(parseRunStopArgs(['stop', 'abc123'])).toEqual({ runId: 'abc123' });
    expect(() => parseRunStopArgs(['stop'])).toThrow(CliError);
    expect(() => parseRunStopArgs(['stop', 'abc123', 'extra'])).toThrow(CliError);
  });

  it('clears stale tmux Node options and anchors an inherited legacy preload', () => {
    const cwd = '/tmp/o8 repo';
    expect(managedRunEnvironmentLines({ PATH: '/usr/bin' }, cwd)).toEqual([
      'unset NODE_OPTIONS',
      "export PATH='/usr/bin'",
    ]);

    const lines = managedRunEnvironmentLines({
      NODE_OPTIONS: '--trace-warnings --import=./scripts/register-server-only-stub.mjs',
    }, cwd);
    const stubUrl = pathToFileURL(`${cwd}/scripts/register-server-only-stub.mjs`).href;
    expect(lines).toEqual([
      'unset NODE_OPTIONS',
      `export NODE_OPTIONS='--trace-warnings --import=${stubUrl}'`,
    ]);
  });

  it('retains only the newest 50 completed local run receipts', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'o8-run-receipts-'));
    receiptRoots.push(dataDir);
    for (let index = 0; index <= 50; index += 1) {
      const id = index.toString(16).padStart(8, '0');
      const paths = initializeManagedRunReceipt({
        schema: 'o8/cli/run-receipt/v1',
        id,
        session: `cortex-run-${id}`,
        command: `command-${index}`,
        cwd: dataDir,
        startedAt: new Date(index * 1_000).toISOString(),
        mode: 'stream',
      }, dataDir);
      writeFileSync(paths.exitFile, '0');
    }

    const oldest = join(dataDir, 'logs', 'run', '00000000.json');
    expect(existsSync(oldest)).toBe(false);
    expect(readLastManagedRunReceipt(dataDir)).toMatchObject({
      id: '00000032',
      command: 'command-50',
      exitStatus: '0',
    });
  });
});
