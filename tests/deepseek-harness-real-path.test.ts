import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = mkdtempSync(path.join(os.tmpdir(), 'o8-deepseek-harness-real-'));
const pidLog = path.join(root, 'pids.log');
const fixture = path.join(process.cwd(), 'tests', 'fixtures', 'deepseek-harness-jsonrpc-runtime.mjs');

beforeAll(() => {
  process.env.O8_OWNED_DEEPSEEK_HARNESS_ROOT = path.join(root, 'sessions');
  process.env.O8_DEEPSEEK_HARNESS_BIN = process.execPath;
  process.env.O8_DEEPSEEK_HARNESS_ARGS = JSON.stringify([fixture]);
  process.env.O8_DEEPSEEK_HARNESS_PID_LOG = pidLog;
  process.env.DEEPSEEK_API_KEY = 'fixture-key';
});

afterAll(() => {
  delete process.env.O8_OWNED_DEEPSEEK_HARNESS_ROOT;
  delete process.env.O8_DEEPSEEK_HARNESS_BIN;
  delete process.env.O8_DEEPSEEK_HARNESS_ARGS;
  delete process.env.O8_DEEPSEEK_HARNESS_PID_LOG;
  delete process.env.DEEPSEEK_API_KEY;
  rmSync(root, { recursive: true, force: true });
});

describe('DeepSeek Harness production runtime seam', () => {
  it('launches, streams, resumes on one JSON-RPC process, reports usage, and interrupts', async () => {
    const { deepSeekHarnessRuntime } = await import('@/lib/runtimes/deepseek-harness');
    const { invalidateDeepSeekHarnessLaunchCache } = await import('@/lib/deepseek-harness/runtime-resolution');
    invalidateDeepSeekHarnessLaunchCache();

    const launched = await deepSeekHarnessRuntime.launch({
      cwd: process.cwd(),
      prompt: 'first turn',
      clientMutationId: 'deepseek-real-path-1',
      packetId: 'packet-fixture',
      laneId: 'lane-fixture',
    });
    expect(launched).toMatchObject({ ok: true });
    expect(launched.sessionKey).toMatch(/^deepseek-harness-owned:/);
    const sessionKey = launched.sessionKey!;

    await expect(deepSeekHarnessRuntime.resume(sessionKey, 'second turn')).resolves.toMatchObject({ ok: true });
    const transcript = await deepSeekHarnessRuntime.readTranscript(sessionKey);
    expect(transcript.filter((entry) => entry.role === 'user').map((entry) => entry.text)).toEqual([
      'first turn',
      'second turn',
    ]);
    expect(transcript.filter((entry) => entry.role === 'assistant').map((entry) => entry.text)).toEqual([
      'fixture response 1',
      'fixture response 2',
    ]);

    const pids = readFileSync(pidLog, 'utf8').trim().split('\n');
    expect(pids).toHaveLength(2);
    expect(new Set(pids).size).toBe(1);
    const { lookupOwnedActiveRunFresh } = await import('@/lib/runtimes/shared/owned-session-index');
    await expect(lookupOwnedActiveRunFresh(sessionKey)).resolves.toMatchObject({
      pid: Number(pids[0]),
      commandIdentity: path.basename(process.execPath),
    });
    await expect(deepSeekHarnessRuntime.getTelemetry?.(sessionKey)).resolves.toMatchObject({
      inputTokens: 30,
      outputTokens: 6,
      cacheReadTokens: 3,
      totalTokens: 39,
      model: 'deepseek-v4-flash',
    });
    await expect(deepSeekHarnessRuntime.interrupt(sessionKey)).resolves.toMatchObject({ ok: true });
    await expect(deepSeekHarnessRuntime.discoverSessions()).resolves.toEqual([
      expect.objectContaining({ sessionKey, runtimeId: 'deepseek-harness', ownership: 'owned' }),
    ]);
  });
});
