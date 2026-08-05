import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { removeLockedDir } from './remove-locked-dir';

const execFileAsync = promisify(execFile);

function ebusyError(): NodeJS.ErrnoException {
  const err = new Error('resource busy or locked') as NodeJS.ErrnoException;
  err.code = 'EBUSY';
  return err;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

const cleanupPaths: string[] = [];
afterEach(async () => {
  for (const p of cleanupPaths.splice(0)) {
    await rm(p, { recursive: true, force: true }).catch(() => {});
  }
});

describe('removeLockedDir', () => {
  it('retries a lock-class error and succeeds', async () => {
    let calls = 0;
    const rmImpl = (async () => {
      calls += 1;
      if (calls < 3) throw ebusyError();
    }) as typeof rm;

    const result = await removeLockedDir('/tmp/fake-target', {
      quarantineBase: '/tmp/fake-trash',
      delaysMs: [1, 1, 1],
      rmImpl,
    });

    expect(result).toEqual({ status: 'removed' });
    expect(calls).toBe(3);
  });

  it('quarantines via a real rename when rm stays locked', async () => {
    const target = await mkdtemp(path.join(tmpdir(), 'o8-locked-target-'));
    const quarantineBase = await mkdtemp(path.join(tmpdir(), 'o8-locked-trash-'));
    cleanupPaths.push(target, quarantineBase);
    await writeFile(path.join(target, 'file.txt'), 'hi', 'utf-8');

    const rmImpl = (async () => { throw ebusyError(); }) as typeof rm;

    const result = await removeLockedDir(target, {
      quarantineBase,
      delaysMs: [1, 1],
      rmImpl,
    });

    expect(result.status).toBe('quarantined');
    if (result.status === 'quarantined') {
      await expect(exists(result.quarantinedTo)).resolves.toBe(true);
      cleanupPaths.push(result.quarantinedTo);
    }
  });

  it('reports failed when the quarantine rename also throws', async () => {
    const rmImpl = (async () => { throw ebusyError(); }) as typeof rm;
    const renameImpl = (async () => { throw new Error('rename refused'); }) as typeof import('node:fs/promises').rename;
    const mkdirImpl = (async () => undefined) as typeof mkdir;

    const result = await removeLockedDir('/tmp/fake-target-2', {
      quarantineBase: '/tmp/fake-trash-2',
      delaysMs: [1, 1],
      rmImpl,
      renameImpl,
      mkdirImpl,
    });

    expect(result).toEqual({ status: 'failed' });
  });

  it('treats ENOENT as already removed', async () => {
    const enoent = new Error('no such file') as NodeJS.ErrnoException;
    enoent.code = 'ENOENT';
    const rmImpl = (async () => { throw enoent; }) as typeof rm;

    const result = await removeLockedDir('/tmp/fake-target-3', {
      quarantineBase: '/tmp/fake-trash-3',
      delaysMs: [1, 1, 1],
      rmImpl,
    });

    expect(result).toEqual({ status: 'removed' });
  });

  it('rethrows non-lock-class errors immediately without retrying', async () => {
    let calls = 0;
    const einval = new Error('invalid argument') as NodeJS.ErrnoException;
    einval.code = 'EINVAL';
    const rmImpl = (async () => {
      calls += 1;
      throw einval;
    }) as typeof rm;

    await expect(removeLockedDir('/tmp/fake-target-4', {
      quarantineBase: '/tmp/fake-trash-4',
      delaysMs: [1, 1, 1],
      rmImpl,
    })).rejects.toThrow('invalid argument');
    expect(calls).toBe(1);
  });

  const itDarwin = process.platform === 'darwin' ? it : it.skip;
  itDarwin('quarantines a real macOS-immutable file end to end (no mocks)', async () => {
    const target = await mkdtemp(path.join(tmpdir(), 'o8-locked-real-'));
    const quarantineBase = await mkdtemp(path.join(tmpdir(), 'o8-locked-real-trash-'));
    cleanupPaths.push(quarantineBase);
    const lockedFile = path.join(target, 'locked.txt');
    await writeFile(lockedFile, 'immutable', 'utf-8');
    await execFileAsync('chflags', ['uchg', lockedFile]);

    let result: Awaited<ReturnType<typeof removeLockedDir>> | undefined;
    try {
      result = await removeLockedDir(target, {
        quarantineBase,
        delaysMs: [1, 1],
        logPrefix: 'test-real-lock',
      });
      expect(result.status).toBe('quarantined');
    } finally {
      if (result?.status === 'quarantined') {
        await execFileAsync('chflags', ['nouchg', path.join(result.quarantinedTo, 'locked.txt')]).catch(() => {});
        cleanupPaths.push(result.quarantinedTo);
      } else {
        await execFileAsync('chflags', ['nouchg', lockedFile]).catch(() => {});
        cleanupPaths.push(target);
      }
    }
  });
});
