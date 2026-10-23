import { guardedWorkspaceInvocation, materializationAwareExecFile } from '@/lib/worktree/materialization-execution';
import type { WorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';

// Both parents and the tree are descriptor-pinned. RENAME_EXCL preserves even
// an empty competing destination; a pool miss never replaces somebody's tree.
const MOVE_TREE = String.raw`
const fs = require('node:fs');
const input = JSON.parse(process.argv[1]);
const parent = fs.openSync(input.parent.canonicalPath, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
const destination = fs.openSync('.', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
const same = (entry, expected) => entry.isDirectory() && !entry.isSymbolicLink() && entry.dev === expected.device && entry.ino === expected.inode;
try {
  if (!same(fs.fstatSync(parent), input.parent) || !same(fs.lstatSync(input.parent.canonicalPath), input.parent)
    || fs.realpathSync(input.parent.canonicalPath) !== input.parent.canonicalPath) throw new Error('Dependency pool parent changed.');
  const python = "import ctypes, json, os, sys\nlibc = ctypes.CDLL(None, use_errno=True)\nrename = libc.renameatx_np\nrename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint32]\nexpected = json.loads(sys.argv[1])\ntree = os.open('node_modules', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=3)\ntry:\n    before = os.fstat(tree)\n    named = os.stat('node_modules', dir_fd=3, follow_symlinks=False)\n    if before.st_dev != expected['device'] or before.st_ino != expected['inode'] or named.st_ino != before.st_ino or named.st_dev != before.st_dev: raise RuntimeError('Dependency pool tree changed.')\n    if rename(3, b'node_modules', 4, b'node_modules', 4) != 0: raise OSError(ctypes.get_errno(), 'Dependency pool rename refused')\n    after = os.stat('node_modules', dir_fd=4, follow_symlinks=False)\n    if after.st_dev != before.st_dev or after.st_ino != before.st_ino: raise RuntimeError('Dependency pool publication changed.')\nfinally:\n    os.close(tree)\n";
  const result = require('node:child_process').spawnSync('/usr/bin/python3', ['-c', python, JSON.stringify(input.tree)], {stdio:['ignore','pipe','pipe',parent,destination], timeout:10000});
  if (result.status !== 0) throw new Error(result.stderr?.toString().trim() || 'Dependency pool publication failed.');
  if (!same(fs.lstatSync('node_modules'), input.tree)) throw new Error('Dependency pool publication changed.');
} finally { fs.closeSync(parent); fs.closeSync(destination); }
`;

export async function publishDependencyPoolTree(
  workspace: string,
  identity: WorktreeMaterializationIdentity,
  parent: WorktreeMaterializationIdentity,
  tree: { device: number; inode: number },
): Promise<void> {
  const invocation = guardedWorkspaceInvocation(process.execPath, ['-e', MOVE_TREE, JSON.stringify({ parent, tree })], identity);
  await materializationAwareExecFile(invocation.command, invocation.args, { cwd: workspace, timeout: 15_000 });
}
