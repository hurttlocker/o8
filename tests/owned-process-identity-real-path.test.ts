import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildPiWriteHelper } from './helpers/pi-write-helper';
import { escalateInterrupt } from '@/lib/runtime/interrupt-escalation';
import { probeOwnedProcessIdentity } from '@/lib/runtimes/shared/owned-session/process-identity';

let helper: string;
beforeAll(() => { helper = buildPiWriteHelper(); }, 180_000);

describe.runIf(process.platform === 'darwin')('kernel process start identity through the bundled helper entry point', () => {
  it('returns boot ID and microsecond kernel start time, stable across probes', async () => {
    const before = Date.now();
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    await once(child, 'spawn');
    try {
      const read = () => JSON.parse(execFileSync(helper, ['process-identity', String(child.pid)], { encoding: 'utf8', timeout: 3_000 }));
      const first = read();
      expect(first).toMatchObject({ version: 1, platform: 'darwin',
        bootId: execFileSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], { encoding: 'utf8' }).trim(),
        startId: expect.stringMatching(/^kernel:\d+:\d{6}$/) });
      const [, seconds, micros] = first.startId.split(':');
      const started = Number(seconds) * 1000 + Number(micros) / 1000;
      expect(started).toBeGreaterThanOrEqual(before - 1);
      expect(started).toBeLessThanOrEqual(Date.now());
      expect(read()).toEqual(first);
    } finally {
      const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
    }
  });

  it('refuses nonexistent or malformed PIDs without reading stdin or reporting an identity', () => {
    for (const pid of ['0', '-1', 'not-a-pid', '2147483647']) {
      const receipt = spawnSync(helper, ['process-identity', pid], { encoding: 'utf8', timeout: 3_000, input: '' });
      expect(receipt.status).not.toBe(0);
      expect(receipt.stdout).toBe('');
    }
  });

  it('keeps Stop unconfirmed when an identified leader exits and its descendant escapes the group', async () => {
    const priorHelper = process.env.O8_PI_WRITE_BIN;
    process.env.O8_PI_WRITE_BIN = helper;
    const script = `const {spawn}=require('node:child_process');
      const child=spawn(process.execPath,['-e',"process.send('ready');setInterval(()=>{},1000)"],
        {detached:true,stdio:['ignore','ignore','ignore','ipc']});
      child.on('message',()=>process.send(child.pid));setInterval(()=>{},1000);`;
    const leader = spawn(process.execPath, ['-e', script], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const exited = once(leader, 'exit');
    let descendant = 0;
    let descendantIdentity: unknown;
    try {
      descendant = Number((await once(leader, 'message'))[0]);
      descendantIdentity = await probeOwnedProcessIdentity(descendant);
      const proof = await probeOwnedProcessIdentity(leader.pid!);
      expect(proof.state).toBe('live');
      if (proof.state !== 'live') throw new Error('Fixture leader identity unavailable.');
      const result = await escalateInterrupt({ pid: leader.pid, processGroupId: leader.pid,
        processIdentity: proof.identity, processIdentityRequired: true });
      expect(result.confirmedDead).toBe(false);
      expect(result.steps[0].sent).toBe(false); // Escaped PID could not be addressed safely.
      expect(await probeOwnedProcessIdentity(descendant)).toEqual(descendantIdentity);
      await exited;
    } finally {
      if (descendant && JSON.stringify(await probeOwnedProcessIdentity(descendant)) === JSON.stringify(descendantIdentity)) {
        try { process.kill(descendant, 'SIGKILL'); } catch { /* Already exited. */ }
      }
      if (leader.exitCode === null && leader.signalCode === null) { leader.kill('SIGKILL'); await exited; }
      if (priorHelper === undefined) delete process.env.O8_PI_WRITE_BIN;
      else process.env.O8_PI_WRITE_BIN = priorHelper;
    }
  }, 15_000);
});
