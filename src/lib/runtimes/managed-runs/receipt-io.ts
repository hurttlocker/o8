import { spawnSync } from 'node:child_process';
import { closeSync, constants, fstatSync, mkdirSync, openSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { resolveManagedRunExitReceipt } from './receipt-path';
import type { ManagedRunRecord } from './types';

// Pin cwd and a directory descriptor before relative leaf I/O. macOS cannot
// traverse directory descriptors through /dev/fd; this follows handoff I/O.
const RECEIPT_IO = String.raw`
const fs = require('node:fs');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const cwd = fs.lstatSync('.'), pinned = fs.fstatSync(3);
if (!cwd.isDirectory() || cwd.dev !== input.device || cwd.ino !== input.inode
  || pinned.dev !== cwd.dev || pinned.ino !== cwd.ino
  || fs.realpathSync('.') !== input.directory) process.exit(1);
if (!/^[A-Za-z0-9]+\.exit$/.test(input.name)) process.exit(1);
let fd;
try {
  const flags = fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
  if (input.writeUnknown) {
    fd = fs.openSync(input.name, flags | fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    fs.writeFileSync(fd, 'signal:UNKNOWN');
  } else {
    fd = fs.openSync(input.name, flags | fs.constants.O_RDONLY);
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > 64) process.exit(1);
    const bytes = Buffer.alloc(64);
    const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    const after = fs.fstatSync(fd), named = fs.lstatSync(input.name);
    if (count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || named.dev !== before.dev || named.ino !== before.ino || !named.isFile()) process.exit(1);
    process.stdout.write(bytes.subarray(0, count));
  }
} catch { process.exitCode = 1; }
finally { if (fd !== undefined) fs.closeSync(fd); }
`;

export function managedRunReceiptIo(rec: ManagedRunRecord, writeUnknown = false): string | null {
  const path = resolveManagedRunExitReceipt(rec.id, rec.exitReceiptPath);
  if (!path) return null;
  const directory = dirname(path);
  let descriptor: number | undefined;
  try {
    // Only the protected legacy location may need creation. Worker receipt
    // directories are initialized by the CLI; never mkdir through mutable roots.
    if (writeUnknown && path === resolveManagedRunExitReceipt(rec.id)) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    descriptor = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const captured = fstatSync(descriptor);
    const result = spawnSync(process.execPath, ['-e', RECEIPT_IO], {
      cwd: directory, stdio: ['pipe', 'pipe', 'pipe', descriptor],
      input: JSON.stringify({ directory, device: captured.dev, inode: captured.ino, name: basename(path), writeUnknown }),
      env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 5_000, maxBuffer: 1024,
      windowsHide: true,
    });
    return !result.error && result.status === 0 ? result.stdout : null;
  } catch { return null; } finally { if (descriptor !== undefined) closeSync(descriptor); }
}
