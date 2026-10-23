import { EMBEDDED_CHILD_POLICY_SCRIPT } from '@/lib/providers/embedded-child-policy';

// The clone is first captured in a private staging directory. Only that exact
// descriptor is published, atomically and without replacing an existing name.
const NATIVE_CLONE = String.raw`
import ctypes, errno, json, os, sys, tempfile, time
libc = ctypes.CDLL(None, use_errno=True)
clone = libc.fclonefileat
clone.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint32]
clone.restype = ctypes.c_int
rename = libc.renameatx_np
rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint32]
rename.restype = ctypes.c_int
stage = tempfile.mkdtemp(prefix='.o8-clone-', dir='.')
stagefd = os.open(stage, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
captured = os.fstat(stagefd)
def same(a, b):
    return a.st_dev == b.st_dev and a.st_ino == b.st_ino
target = None
try:
    started = time.monotonic()
    if clone(3, stagefd, b'tree', 1) != 0:
        error = ctypes.get_errno()
        if error in (errno.ENOTSUP, errno.EXDEV, errno.ENOSYS, errno.EINVAL):
            sys.exit(46)
        raise OSError(error, os.strerror(error))
    clone_ms = round((time.monotonic() - started) * 1000)
    target = os.open('tree', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=stagefd)
    receipt = os.fstat(target)
    if not same(receipt, os.stat('tree', dir_fd=stagefd, follow_symlinks=False)):
        raise RuntimeError('Pinned clone target changed in staging.')
    if rename(stagefd, b'tree', 4, os.fsencode(sys.argv[1]), 4) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    if not same(receipt, os.stat(sys.argv[1], dir_fd=4, follow_symlinks=False)):
        raise RuntimeError('Pinned clone target changed during publication.')
    print(json.dumps({'device': receipt.st_dev, 'inode': receipt.st_ino, 'cloneMs': clone_ms}))
finally:
    if target is not None:
        os.close(target)
    # Never recursively clean an unreceipted tree or a competing namespace.
    try:
        if same(captured, os.stat(stage, follow_symlinks=False)):
            os.rmdir(stage)
    except OSError:
        pass
    os.close(stagefd)
`;

export const APFS_DIRECTORY_CLONE_SCRIPT = EMBEDDED_CHILD_POLICY_SCRIPT + String.raw`
async function cloneDirectory(sourcePath, targetPath) {
  if (process.platform !== 'darwin') return false;
  const source = fs.openSync(sourcePath, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  const parent = fs.openSync('.', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(source);
    const sameSource = entry => entry.isDirectory() && !entry.isSymbolicLink()
      && entry.dev === before.dev && entry.ino === before.ino
      && entry.mtimeMs === before.mtimeMs && entry.ctimeMs === before.ctimeMs;
    if (!sameSource(fs.lstatSync(sourcePath))) throw new Error('Pinned clone source changed before capture.');
    await waitForStep('clone-source');
    if (!sameSource(fs.lstatSync(sourcePath))) throw new Error('Pinned clone source changed before cloning.');
    const result = withO8ChildPolicy(env => require('node:child_process').spawnSync('/usr/bin/python3', [
      '-c', ${JSON.stringify(NATIVE_CLONE)}, targetPath,
    ], { env, stdio: ['ignore', 'pipe', 'pipe', source, parent], timeout: 60000 }));
    if (result.status !== 0) {
      try { fs.lstatSync(targetPath); throw new Error('Pinned clone left an unreceipted target.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (result.status === 46 || result.error?.code === 'ENOENT') return false;
      throw new Error('Pinned directory clone failed: ' + (result.stderr?.toString().trim() || result.error?.message || result.signal));
    }
    const receipt = JSON.parse(result.stdout.toString());
    if (process.env.O8_DEPENDENCY_CLONE_PROFILE === '1') console.error('[dependency-clone-native-ms]', receipt.cloneMs);
    await waitForStep('clone-receipted');
    const target = fs.lstatSync(targetPath);
    await waitForStep('clone-created');
    const published = fs.lstatSync(targetPath);
    const sourceAfter = fs.lstatSync(sourcePath);
    if (!sourceAfter.isDirectory() || sourceAfter.isSymbolicLink()
      || sourceAfter.dev !== before.dev || sourceAfter.ino !== before.ino) {
      throw new Error('Pinned clone source changed during cloning.');
    }
    if (!target.isDirectory() || target.isSymbolicLink()
      || target.dev !== receipt.device || target.ino !== receipt.inode
      || !published.isDirectory() || published.isSymbolicLink()
      || published.dev !== target.dev || published.ino !== target.ino) {
      throw new Error('Pinned clone target changed before publication.');
    }
    return { device: target.dev, inode: target.ino, sourceChanged: !sameSource(fs.fstatSync(source)) || !sameSource(sourceAfter) };
  } finally {
    fs.closeSync(source);
    fs.closeSync(parent);
  }
}
`;
