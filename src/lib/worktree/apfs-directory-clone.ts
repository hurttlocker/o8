// Executed inside the pinned leaf process. Both directories are opened there;
// the native call receives descriptors, never a destination namespace to follow.
const NATIVE_CLONE = String.raw`
import ctypes, errno, json, os, sys
libc = ctypes.CDLL(None, use_errno=True)
clone = libc.fclonefileat
clone.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint32]
clone.restype = ctypes.c_int
if clone(3, 4, os.fsencode(sys.argv[1]), 1) != 0:
    error = ctypes.get_errno()
    if error in (errno.ENOTSUP, errno.EXDEV, errno.ENOSYS, errno.EINVAL):
        sys.exit(46)
    raise OSError(error, os.strerror(error))
target = os.open(sys.argv[1], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=4)
try:
    receipt = os.fstat(target)
    print(json.dumps({'device': receipt.st_dev, 'inode': receipt.st_ino}))
finally:
    os.close(target)
`;

export const APFS_DIRECTORY_CLONE_SCRIPT = String.raw`
async function cloneDirectory(sourcePath, targetPath) {
  if (process.platform !== 'darwin') return false;
  const source = fs.openSync(sourcePath, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  const parent = fs.openSync('.', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(source);
    const sourceName = fs.lstatSync(sourcePath);
    const sameSource = entry => entry.isDirectory() && !entry.isSymbolicLink()
      && entry.dev === before.dev && entry.ino === before.ino
      && entry.mtimeMs === before.mtimeMs && entry.ctimeMs === before.ctimeMs;
    if (!sameSource(sourceName)) throw new Error('Pinned clone source changed before capture.');
    await waitForStep('clone-source');
    if (!sameSource(fs.lstatSync(sourcePath))) throw new Error('Pinned clone source changed before cloning.');
    const result = require('node:child_process').spawnSync('/usr/bin/python3', [
      '-c', ${JSON.stringify(NATIVE_CLONE)}, targetPath,
    ], { stdio: ['ignore', 'pipe', 'pipe', source, parent], timeout: 60000 });
    if (result.status !== 0) {
      // Unsupported calls must leave no target. A partial or competing target
      // is retained and refused, never erased to make room for the fallback.
      try { fs.lstatSync(targetPath); throw new Error('Pinned clone left an unreceipted target.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (result.status === 46 || result.error?.code === 'ENOENT') return false;
      throw new Error('Pinned directory clone failed: ' + (result.stderr?.toString().trim() || result.error?.message || result.signal));
    }
    const receipt = JSON.parse(result.stdout.toString());
    await waitForStep('clone-receipted');
    const target = fs.lstatSync(targetPath);
    await waitForStep('clone-created');
    const published = fs.lstatSync(targetPath);
    if (!sameSource(fs.fstatSync(source)) || !sameSource(fs.lstatSync(sourcePath))) {
      throw new Error('Pinned clone source changed during cloning.');
    }
    if (!target.isDirectory() || target.isSymbolicLink()
      || target.dev !== receipt.device || target.ino !== receipt.inode
      || !published.isDirectory() || published.isSymbolicLink()
      || published.dev !== target.dev || published.ino !== target.ino) {
      throw new Error('Pinned clone target changed before publication.');
    }
    return true;
  } finally {
    fs.closeSync(source);
    fs.closeSync(parent);
  }
}
`;
