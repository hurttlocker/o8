import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BACKEND_ABORT_REASON,
  BACKEND_PROBE_MAX_ATTEMPTS,
  O8BackendAbortError,
  probeO8Backend,
  restoreRequireApproval,
  runBackendGuardedCollection,
  type BenchmarkRunControlReceipt,
} from '../../scripts/bench/coding-run-control';

function errorWithCause(code: string, message = 'fetch failed'): Error {
  return Object.assign(new TypeError(message), { cause: { code } });
}

const noWait = async (): Promise<void> => undefined;

describe('coding benchmark run control', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'o8-coding-run-control-'));
    fs.writeFileSync(path.join(dataDir, 'api-port'), '47120\n');
    fs.writeFileSync(path.join(dataDir, 'ws-token'), 'test-operator-token\n');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('treats one failed probe attempt followed by success as healthy and does not abort', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(errorWithCause('ECONNRESET'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ product: 'o8' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ product: 'o8' }), { status: 200 }));
    const committedArms: Array<{ outcome: 'valid' }> = [];
    const controls: BenchmarkRunControlReceipt[] = [];

    await expect(runBackendGuardedCollection({
      arms: ['raw'],
      probe: () => probeO8Backend({ dataDir, fetchImpl, timeoutMs: 50, sleep: noWait }),
      runArm: (): { outcome: 'valid' } => ({ outcome: 'valid' }),
      commitArm: (arm) => committedArms.push(arm),
      onRunControl: (receipt) => controls.push(receipt),
    })).resolves.toBe(1);

    expect(committedArms).toEqual([{ outcome: 'valid' }]);
    expect(controls.at(-1)).toMatchObject({
      status: 'completed',
      completedArms: 1,
    });
    expect(controls.some((receipt) => (
      receipt.backendProbe?.attemptsMade === 2
      && receipt.backendProbe.attempts.map((attempt) => attempt.outcome).join(',') === 'io-error,healthy'
    ))).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:47120/api/panel/status',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer test-operator-token' }),
      }),
    );
  });

  it('aborts only after every probe attempt fails and records the attempt count', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ product: 'o8' }), { status: 200 }))
      .mockRejectedValue(errorWithCause('ECONNREFUSED'));
    const controls: BenchmarkRunControlReceipt[] = [];
    const committedArms: string[] = [];
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const collection = runBackendGuardedCollection({
      arms: ['raw', 'governed'],
      probe: () => probeO8Backend({ dataDir, fetchImpl, timeoutMs: 50, sleep: noWait }),
      runArm: (condition) => condition,
      commitArm: (condition) => committedArms.push(condition),
      onRunControl: (receipt) => controls.push(receipt),
    });

    await expect(collection).rejects.toBeInstanceOf(O8BackendAbortError);
    expect(committedArms).toEqual(['raw']);
    expect(controls.at(-1)).toMatchObject({
      status: 'infrastructure-aborted',
      completedArms: 1,
      abortReason: BACKEND_ABORT_REASON,
      backendDetail: expect.stringContaining('connection-refused (ECONNREFUSED)'),
      backendProbe: {
        reachable: false,
        attemptsMade: BACKEND_PROBE_MAX_ATTEMPTS,
        finalErrorCode: 'ECONNREFUSED',
      },
    });
    expect(controls.at(-1)?.backendProbe?.attempts).toHaveLength(BACKEND_PROBE_MAX_ATTEMPTS);
    expect(controls.at(-1)?.backendProbe?.totalElapsedMs).toEqual(expect.any(Number));
    expect(fetchImpl).toHaveBeenCalledTimes(BACKEND_PROBE_MAX_ATTEMPTS + 1);
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('results are not a product measurement'));
  });

  it('records connection refusal and timeout as distinct probe outcomes', async () => {
    const refusedFetch = vi.fn<typeof fetch>().mockRejectedValue(errorWithCause('ECONNREFUSED'));
    const timeoutFetch = vi.fn<typeof fetch>().mockRejectedValue(new DOMException('request expired', 'TimeoutError'));

    const refused = await probeO8Backend({
      dataDir,
      fetchImpl: refusedFetch,
      maxAttempts: 1,
      timeoutMs: 50,
    });
    const timedOut = await probeO8Backend({
      dataDir,
      fetchImpl: timeoutFetch,
      maxAttempts: 1,
      timeoutMs: 50,
    });

    expect(refused).toMatchObject({
      reachable: false,
      finalErrorCode: 'ECONNREFUSED',
      attempts: [{ outcome: 'connection-refused', errorCode: 'ECONNREFUSED' }],
    });
    expect(timedOut).toMatchObject({
      reachable: false,
      finalErrorCode: 'TimeoutError',
      attempts: [{ outcome: 'timeout', errorCode: 'TimeoutError' }],
    });
  });

  it('restores requireApproval through operator-defaults.json when the API is unavailable', async () => {
    fs.writeFileSync(path.join(dataDir, 'operator-defaults.json'), JSON.stringify({
      requireApproval: 'always',
      parallelCap: 4,
    }));
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('backend connection refused'));

    const result = await restoreRequireApproval('surface', { dataDir, fetchImpl, timeoutMs: 50 });

    expect(result).toEqual({ restored: true, method: 'file' });
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'operator-defaults.json'), 'utf8'))).toEqual({
      requireApproval: 'surface',
      parallelCap: 4,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:47120/api/panel/operator-defaults',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ requireApproval: 'surface' }),
      }),
    );
  });
});
