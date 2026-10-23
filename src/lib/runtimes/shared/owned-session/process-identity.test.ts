import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OwnedRunRecord, OwnedSessionRecord } from './types';

const { nativeProbe, platformProbe, markerProbe } = vi.hoisted(() => ({
  nativeProbe: vi.fn(), platformProbe: vi.fn(), markerProbe: vi.fn(),
}));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: nativeProbe }) };
});
vi.mock('@/lib/worktree/metadata-lock-process-identity', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/worktree/metadata-lock-process-identity')>(),
  probeMetadataLockProcessIdentity: platformProbe,
}));
vi.mock('./run-process-proof', () => ({ probeOwnedRunProcessClaim: markerProbe }));

import { assertOwnedSessionProcessIdentity, captureOwnedRunIdentity, probeOwnedRunIdentity } from './process-identity';

function fixture() {
  const run: OwnedRunRecord = { id: 'capture-run', mode: 'launch', prompt: '', startedAt: new Date().toISOString(),
    pid: process.pid, processMarker: 'capture-marker', processIdentityRequired: true, detachMode: 'detached',
    stdoutPath: '', stderrPath: '', outcome: 'running' };
  return { run, session: { packetId: 'capture-packet', activeRun: run } as OwnedSessionRecord };
}

beforeEach(() => {
  nativeProbe.mockReset().mockRejectedValue(new Error('helper unavailable'));
  platformProbe.mockReset();
  markerProbe.mockReset().mockResolvedValue({ state: 'match' });
});
afterEach(() => vi.restoreAllMocks());

describe.skipIf(process.platform === 'win32')('owned identity source selection', () => {
  it('keeps a self-launched run legacy and warns once when no capture source works', async () => {
    platformProbe.mockResolvedValue({ state: 'unknown', detail: 'process start time unavailable' });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { run, session } = fixture();
    await captureOwnedRunIdentity(session, 'codex', run);
    expect(run.processIdentityRequired).toBe(false);
    expect(run.processIdentity).toBeUndefined();
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0].join(' ')).toContain('process start time unavailable');
    await expect(assertOwnedSessionProcessIdentity(session, 'codex')).resolves.toBeUndefined();
    expect(warning).toHaveBeenCalledTimes(1);
  });

  it.runIf(process.platform === 'darwin')('pins ps capture through helper upgrades and rejects changed fallback start times', async () => {
    const identity = { version: 1, platform: 'darwin', bootId: 'boot', startId: 'Mon Oct 19 12:00:00 2026' };
    platformProbe.mockResolvedValue({ state: 'live', identity });
    const { run, session } = fixture();
    await captureOwnedRunIdentity(session, 'codex', run);
    expect(run).toMatchObject({ processIdentityRequired: true, processIdentitySource: 'ps', processIdentity: identity });
    nativeProbe.mockClear().mockResolvedValue({ stdout: JSON.stringify({ ...identity, startId: 'kernel:1:000001' }) });
    expect(await probeOwnedRunIdentity(run)).toEqual({ state: 'match' });
    expect(nativeProbe).not.toHaveBeenCalled();
    platformProbe.mockResolvedValue({ state: 'live', identity: { ...identity, startId: 'Mon Oct 19 12:00:01 2026' } });
    expect(await probeOwnedRunIdentity(run)).toEqual({ state: 'mismatch' });
  });
});
