import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

const probe = vi.hoisted(() => ({ failures: 0, uuid: 'abcdef12-3456-7890-abcd-ef1234567890' }));
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  const nativeExec = promisify(actual.execFile);
  const run = async (file: string, args: string[], options: object) => {
    if (file === '/bin/df') return { stdout: 'Filesystem blocks Used Available Capacity Mounted on\n/dev/disk-test 1 1 1 1% /\n', stderr: '' };
    if (file === '/usr/sbin/diskutil') {
      if (probe.failures-- > 0) throw new Error('Fixture diskutil timed out');
      return { stdout: `<key>VolumeUUID</key><string>${probe.uuid}</string>`, stderr: '' };
    }
    return nativeExec(file, args, options);
  };
  return { ...actual, execFile: Object.assign(actual.execFile.bind(null), { [promisify.custom]: run }) };
});

const hostPlatform = process.platform;
const roots: string[] = [];
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: hostPlatform });
  probe.failures = 0; probe.uuid = 'abcdef12-3456-7890-abcd-ef1234567890';
  vi.resetModules();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'o8-volume-restart-'))); roots.push(root);
  const workspace = path.join(root, 'workspace'); mkdirSync(workspace);
  return { root, workspace };
}

describe.skipIf(hostPlatform === 'win32')('macOS volume identity across persisted workspace receipts', () => {
  it('keeps pinned writes and ownership checks working after a transient UUID failure and resolver restart', async () => {
    const { root, workspace } = fixture();
    const firstIdentity = await import('@/lib/worktree/materialization-identity');
    const firstIo = await import('@/lib/worktree/materialization-leaf-io');
    probe.failures = 1;
    const identity = await firstIdentity.captureWorktreeMaterializationIdentity(workspace);
    const file = await firstIo.writePinnedWorkspaceFile(workspace, identity, 'settings.json', '{"version":1}');
    const receiptPath = path.join(root, 'receipt.json');
    writeFileSync(receiptPath, JSON.stringify({ identity, file }));
    vi.resetModules(); // Reconstruct the resolver and consumers from durable receipts.
    const resumed = JSON.parse(readFileSync(receiptPath, 'utf8')) as { identity: typeof identity; file: typeof file };
    const restartedIdentity = await import('@/lib/worktree/materialization-identity');
    const restartedIo = await import('@/lib/worktree/materialization-leaf-io');
    await expect(restartedIdentity.assertWorktreeMaterializationIdentity(workspace, resumed.identity))
      .resolves.toMatchObject({ volumeId: `volume-uuid:${probe.uuid}` });
    await expect(restartedIo.writePinnedWorkspaceFile(workspace, resumed.identity, 'settings.json', '{"version":2}', undefined, resumed.file))
      .resolves.toMatchObject({ volumeId: resumed.file.volumeId });
    expect(readFileSync(path.join(workspace, 'settings.json'), 'utf8')).toBe('{"version":2}');
  });

  it('still refuses a changed volume UUID without changing the persisted target', async () => {
    const { workspace } = fixture();
    const { captureWorktreeMaterializationIdentity } = await import('@/lib/worktree/materialization-identity');
    const { writePinnedWorkspaceFile } = await import('@/lib/worktree/materialization-leaf-io');
    const identity = await captureWorktreeMaterializationIdentity(workspace);
    const file = await writePinnedWorkspaceFile(workspace, identity, 'settings.json', 'preserve');
    vi.resetModules(); probe.uuid = '11111111-2222-3333-4444-555555555555';
    const freshIdentity = await import('@/lib/worktree/materialization-identity');
    const freshIo = await import('@/lib/worktree/materialization-leaf-io');
    await expect(freshIdentity.assertWorktreeMaterializationIdentity(workspace, identity)).rejects.toThrow('volume identity mismatch');
    await expect(freshIo.writePinnedWorkspaceFile(workspace, identity, 'settings.json', 'overwrite', undefined, file)).rejects.toThrow('volume identity does not match');
    expect(readFileSync(path.join(workspace, 'settings.json'), 'utf8')).toBe('preserve');
  });
});
