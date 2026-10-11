import { spawn } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRetainedGeneratedOutputFixture } from './generated-output-fixture';

import { purgeExactDirectory, readCapturedPurgeCwdSnapshot,
  type CapturedPurgeProcessWitness } from '@/lib/workspace/exact-directory-purge';

async function fixture() {
  const root = await createRetainedGeneratedOutputFixture('o8-purge-witness-');
  const candidate = path.join(root, 'claimed');
  await mkdir(candidate);
  await writeFile(path.join(candidate, 'proof.txt'), 'retain until authorized');
  const identity = await stat(candidate);
  return { root, candidate, identity: { device: identity.dev, inode: identity.ino } };
}

describe('native purge process capability', () => {
  it('excludes only its attested helper and invalidates the capability after native close', async () => {
    const { root, candidate, identity } = await fixture();
    let captured: CapturedPurgeProcessWitness | undefined;
    await purgeExactDirectory(candidate, identity, undefined, async (_path, witness) => {
      captured = witness;
      const snapshot = await readCapturedPurgeCwdSnapshot(witness, root);
      expect(snapshot.status).toBe('ready');
      expect(snapshot.rows.some(row => row.cwd === candidate)).toBe(false);
      await expect(readCapturedPurgeCwdSnapshot({} as CapturedPurgeProcessWitness, root))
        .rejects.toThrow('not live authority');
      await expect(readCapturedPurgeCwdSnapshot(witness, path.join(root, 'other')))
        .rejects.toThrow('not live authority');
    });
    expect(captured).toBeDefined();
    await expect(readCapturedPurgeCwdSnapshot(captured!, root)).rejects.toThrow('not live authority');
    await expect(stat(candidate)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 30_000);

  it('preserves a real other consumer and settles the helper before refusing content release', async () => {
    const { root, candidate, identity } = await fixture();
    const consumer = spawn(process.execPath, ['-e', "process.stdout.write('ready\\n');process.stdin.resume();"], {
      cwd: root, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const closed = new Promise<number | null>(resolve => consumer.once('close', resolve));
    await new Promise<void>((resolve, reject) => {
      consumer.stdout.once('data', () => resolve());
      consumer.once('error', reject);
    });
    let captured: CapturedPurgeProcessWitness | undefined;
    try {
      await expect(purgeExactDirectory(candidate, identity, undefined, async (_path, witness) => {
        captured = witness;
        const snapshot = await readCapturedPurgeCwdSnapshot(witness, root);
        expect(snapshot.status).toBe('ready');
        expect(snapshot.rows.some(row => row.pid === consumer.pid)).toBe(true);
        throw new Error('another consumer still owns the workspace');
      })).rejects.toThrow('another consumer');
      await expect(readCapturedPurgeCwdSnapshot(captured!, root)).rejects.toThrow('not live authority');
      expect(await readFile(path.join(candidate, 'proof.txt'), 'utf8')).toBe('retain until authorized');
      const preserved = await stat(candidate);
      expect({ device: preserved.dev, inode: preserved.ino }).toEqual(identity);
    } finally {
      consumer.stdin.end();
      expect(await closed).toBe(0);
    }
  }, 30_000);
});
