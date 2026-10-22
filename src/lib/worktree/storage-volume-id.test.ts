import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

// macOS mounts the sealed system volume at / and the Data volume behind it; both
// report one st_dev. df names the device each path lives on, diskutil its UUID.
const SYSTEM_UUID = '6a21fd45-7a7b-43ee-b69c-1ebe49db0df9';
const DATA_UUID = '70aa7edb-d15c-4653-ac9b-a55d5c916e77';
const df = vi.hoisted(() => ({ failures: 0, diskFailures: 0, diskEmpty: 0, diskCalls: 0, device: '' }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const run = async (file: string, args: string[]) => {
    if (file === '/bin/df') {
      if (df.failures > 0) { df.failures -= 1; throw new Error('df timed out'); }
      const device = df.device || (args[1] === '/' ? '/dev/disk1s1s1' : '/dev/disk1s2');
      return { stdout: `Filesystem 512-blocks Used Available Capacity Mounted on\n${device} 1 1 1 1% /\n`, stderr: '' };
    }
    if (file === '/usr/sbin/diskutil') {
      df.diskCalls += 1;
      if (df.diskFailures-- > 0) throw new Error('diskutil timed out');
      if (df.diskEmpty-- > 0) return { stdout: '<plist><dict><key>FilesystemType</key><string>smbfs</string></dict></plist>', stderr: '' };
      const uuid = args[2] === '/dev/disk1s1s1' ? SYSTEM_UUID : DATA_UUID;
      return { stdout: `<key>VolumeUUID</key>\n<string>${uuid.toUpperCase()}</string>`, stderr: '' };
    }
    throw new Error(`unexpected command ${file}`);
  };
  const execFile = Object.assign(() => { throw new Error('callback execFile is not used'); }, { [promisify.custom]: run });
  return { ...actual, execFile };
});
vi.mock('node:fs/promises', async (original) => ({
  ...await original<typeof import('node:fs/promises')>(),
  stat: async () => ({ dev: BigInt(16777220) }),
}));

const platform = process.platform;
afterEach(() => {
  df.failures = 0; df.diskFailures = 0; df.diskEmpty = 0; df.diskCalls = 0; df.device = '';
  Object.defineProperty(process, 'platform', { value: platform });
  vi.resetModules();
});

async function volumeIdsInOrder(paths: string[]) {
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  const { resolveStorageVolumeId } = await import('./storage-telemetry');
  const ids: Record<string, string> = {};
  for (const target of paths) ids[target] = await resolveStorageVolumeId(target);
  return ids;
}

describe('resolveStorageVolumeId on macOS (#3748)', () => {
  it('gives each mounted volume its own identity when volumes share st_dev, whichever path a process resolves first', async () => {
    const expected = { '/': `volume-uuid:${SYSTEM_UUID}`, '/Users/o8/worktrees': `volume-uuid:${DATA_UUID}` };
    expect(await volumeIdsInOrder(['/', '/Users/o8/worktrees'])).toEqual(expected);
    vi.resetModules();
    expect(await volumeIdsInOrder(['/Users/o8/worktrees', '/'])).toEqual(expected);
  });

  it('refuses rather than caching a fallback identity when df fails, so one worktree never gets two', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const { resolveStorageVolumeId } = await import('./storage-telemetry');
    df.failures = 1;
    await expect(resolveStorageVolumeId('/Users/o8/worktrees')).resolves.toBe(`volume-uuid:${DATA_UUID}`);
    df.failures = 2;
    await expect(resolveStorageVolumeId('/Users/o8/other')).rejects.toThrow('volume identity is unavailable');
    await expect(resolveStorageVolumeId('/Users/o8/other')).resolves.toBe(`volume-uuid:${DATA_UUID}`);
  });
  it('retries a transient UUID failure rather than persisting a device fallback', async () => {
    df.diskFailures = 1;
    expect(await volumeIdsInOrder(['/fixture/worktrees'])).toEqual({ '/fixture/worktrees': `volume-uuid:${DATA_UUID}` });
    expect(df.diskCalls).toBe(2);
  });

  it('retries failed probes, then refuses and uncaches the failure so a healthy probe can recover', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const { resolveStorageVolumeId } = await import('./storage-telemetry');
    df.device = '/dev/disk9s1'; df.diskFailures = 2;
    await expect(resolveStorageVolumeId('/fixture/worktrees')).rejects.toThrow('volume identity is unavailable');
    expect(df.diskCalls).toBe(2);
    await expect(resolveStorageVolumeId('/fixture/worktrees')).resolves.toBe(`volume-uuid:${DATA_UUID}`);
    expect(df.diskCalls).toBe(3);
  });

  it.each(['//host/share', '//user@host/share', 'host:/path'])('uses device identity for network source %s without invoking diskutil', async device => {
    df.device = device; df.diskFailures = 2;
    expect(await volumeIdsInOrder(['/fixture/share'])).toEqual({ '/fixture/share': 'device:16777220' });
    expect(df.diskCalls).toBe(0);
    vi.resetModules();
    expect(await volumeIdsInOrder(['/fixture/share'])).toEqual({ '/fixture/share': 'device:16777220' });
    expect(df.diskCalls).toBe(0);
  });

  it.each([0, 1])('records device identity when a successful probe has no UUID after %i failures', async failures => {
    df.diskFailures = failures; df.diskEmpty = 1;
    expect(await volumeIdsInOrder(['/fixture/share'])).toEqual({ '/fixture/share': 'device:16777220' });
    expect(df.diskCalls).toBe(failures + 1);
    expect(await volumeIdsInOrder(['/fixture/share'])).toEqual({ '/fixture/share': 'device:16777220' });
    expect(df.diskCalls).toBe(failures + 1);
    vi.resetModules(); df.diskEmpty = 1;
    expect(await volumeIdsInOrder(['/fixture/share'])).toEqual({ '/fixture/share': 'device:16777220' });
  });

});
