/**
 * #3565: probing another process's identity runs `ps` and `sysctl` on macOS.
 * When the event loop is held past the probe's 2 second limit, the limit's
 * timer runs before the finished command's exit and output are handled. The
 * probe must still report the finished command's result, not a timeout.
 */
import { spawn } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';

import { probeMetadataLockProcessIdentity } from '@/lib/worktree/metadata-lock-process-identity';

const other = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
afterAll(() => { other.kill('SIGKILL'); });

describe('metadata-lock identity probe on a busy event loop (#3565)', () => {
  it.runIf(process.platform === 'darwin')('reports a live process whose probe commands finished while the loop was held', async () => {
    const probe = probeMetadataLockProcessIdentity(other.pid!);
    // Hold the loop past the 2 second limit; `ps` and `sysctl` finish meanwhile.
    const until = Date.now() + 2_500;
    while (Date.now() < until) { /* busy */ }
    expect(await probe).toMatchObject({ state: 'live', identity: { platform: 'darwin' } });
  }, 30_000);

  it.runIf(process.platform === 'darwin')('still reports a live process on an idle loop', async () => {
    expect(await probeMetadataLockProcessIdentity(other.pid!)).toMatchObject({ state: 'live' });
  }, 30_000);
});
