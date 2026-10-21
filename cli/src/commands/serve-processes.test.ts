import { beforeEach, describe, expect, it, vi } from 'vitest';

const sampling = vi.hoisted(() => ({
  tables: [] as string[],
  probe: vi.fn(),
}));
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFile: Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: async () => {
      if (!sampling.tables.length) throw new Error('Unexpected process sample');
      return { stdout: sampling.tables.shift()! };
    },
  }),
}));
vi.mock('../../../src/lib/worktree/metadata-lock-process-identity.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/lib/worktree/metadata-lock-process-identity')>(),
  probeMetadataLockProcessIdentity: sampling.probe,
}));

import { captureServeProcesses, type ServeProcessClaim } from './serve-processes';

const identity = { version: 1, platform: 'linux', bootId: 'test-boot', startId: '10' } as const;
const root: ServeProcessClaim = { pid: 100, identity };
const live = { state: 'live', identity };
const tree = '100 1 S\n101 100 S\n';
beforeEach(() => {
  sampling.tables.length = 0;
  sampling.probe.mockReset().mockResolvedValue(live);
});

describe.skipIf(process.platform === 'win32')('serve process capture sampling races', () => {
  it.each(['', '101 100 Z\n'])('accepts a captured leaf that exits before ancestry refresh (%s)', async (leaf) => {
    sampling.tables.push(tree, `100 1 S\n${leaf}`);
    await expect(captureServeProcesses([root])).resolves.toEqual([root]);
  });

  it('accepts an unidentified leaf only after refreshed zombie confirmation', async () => {
    sampling.tables.push(tree, '100 1 S\n101 100 Z\n');
    sampling.probe.mockResolvedValueOnce(live).mockResolvedValueOnce({ state: 'unknown', detail: 'exiting' });
    await expect(captureServeProcesses([root])).resolves.toEqual([root]);
  });

  it('refuses a surviving grandchild beneath an exited intermediate', async () => {
    sampling.tables.push(`${tree}102 101 S\n`, '100 1 S\n102 1 S\n');
    await expect(captureServeProcesses([root])).rejects.toThrow(/unclaimed descendant/i);
  });

  it('refuses live reparenting', async () => {
    sampling.tables.push(tree, '100 1 S\n101 999 S\n');
    await expect(captureServeProcesses([root])).rejects.toThrow('ancestry changed');
  });

  it('accepts an unknown seed probe only after refreshed exit confirmation', async () => {
    sampling.tables.push('100 1 S\n', '1 0 S\n', '1 0 S\n');
    sampling.probe.mockResolvedValue({ state: 'unknown', detail: 'read raced exit' });
    await expect(captureServeProcesses([root])).resolves.toEqual([root]);
  });

  it('refuses an unknown exiting seed with a surviving original descendant', async () => {
    sampling.tables.push(`${tree}102 101 S\n`, '102 1 S\n', '102 1 S\n');
    sampling.probe.mockResolvedValue({ state: 'unknown', detail: 'read raced exit' });
    await expect(captureServeProcesses([root])).rejects.toThrow(/unclaimed descendant/i);
  });

  it('retains all supplied seed claims when checking an exited parent subtree', async () => {
    const child = { pid: 101, identity };
    sampling.tables.push(tree, '101 1 S\n', '101 1 S\n');
    sampling.probe.mockResolvedValueOnce({ state: 'unknown', detail: 'read raced exit' }).mockResolvedValue(live);
    await expect(captureServeProcesses([root, child])).resolves.toEqual([root, child]);
  });

  it('refuses a still-live unknown identity and preserves diagnostic detail', async () => {
    sampling.tables.push('100 1 S\n', '100 1 S\n');
    sampling.probe.mockResolvedValue({ state: 'unknown', detail: 'read denied' });
    await expect(captureServeProcesses([root])).rejects.toThrow('read denied');
  });

  it('refuses a live birth mismatch without treating it as an exit', async () => {
    sampling.tables.push('100 1 S\n');
    sampling.probe.mockResolvedValue({ state: 'live', identity: { ...identity, startId: 'replacement' } });
    await expect(captureServeProcesses([root])).rejects.toThrow('ownership changed');
  });
});
