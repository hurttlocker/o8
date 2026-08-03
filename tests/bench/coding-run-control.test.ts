import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BACKEND_ABORT_REASON,
  O8BackendAbortError,
  probeO8Backend,
  restoreRequireApproval,
  runBackendGuardedCollection,
  type BenchmarkRunControlReceipt,
} from '../../scripts/bench/coding-run-control';

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

  it('aborts on an unreachable backend without recording the arm as invalid', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ product: 'o8' }), { status: 200 }))
      .mockRejectedValueOnce(new TypeError('backend connection refused'));
    const committedArms: Array<{ outcome: 'valid' | 'invalid' }> = [];
    const controls: BenchmarkRunControlReceipt[] = [];
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const collection = runBackendGuardedCollection({
      arms: ['raw', 'governed'],
      probe: () => probeO8Backend({ dataDir, fetchImpl, timeoutMs: 50 }),
      runArm: (condition): { outcome: 'valid' | 'invalid' } => ({
        outcome: condition === 'raw' ? 'valid' : 'invalid',
      }),
      commitArm: (arm) => committedArms.push(arm),
      onRunControl: (receipt) => controls.push(receipt),
    });

    await expect(collection).rejects.toBeInstanceOf(O8BackendAbortError);
    expect(committedArms).toEqual([{ outcome: 'valid' }]);
    expect(controls.at(-1)).toEqual({
      status: 'infrastructure-aborted',
      completedArms: 1,
      abortReason: BACKEND_ABORT_REASON,
      backendDetail: 'backend connection refused',
    });
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('results are not a product measurement'));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:47120/api/panel/status',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer test-operator-token' }),
      }),
    );
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
