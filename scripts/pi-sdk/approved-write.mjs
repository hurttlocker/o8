// Host-only commit helper. The inherited directory descriptor and cwd must agree
// before any side effect; all mutations use names relative to that pinned cwd.
import { randomUUID } from 'node:crypto';
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync,
  openSync, readSync, realpathSync, renameSync, unlinkSync, writeSync,
} from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

const MAX_BYTES = 50_000;
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const protectedPath = path => path.split(/[\\/]/).some(part => part === '..'
  || part.toLowerCase() === '.git' || part.toLowerCase().startsWith('.env'));
let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) {
  input += chunk;
  if (Buffer.byteLength(input) > MAX_BYTES * 10) process.exit(1);
}

let temp;
let tempFd;
let tempIdentity;
let request;
function checkParent() {
  const { root, parent } = request;
  const rel = relative(root, parent.path);
  if (isAbsolute(rel) || rel.startsWith('..') || protectedPath(rel)
    || realpathSync(root) !== root || realpathSync('.') !== parent.path) throw new Error('Parent changed');
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || !same(rootStat, parent.root)) throw new Error('Root changed');
  let current = root;
  for (const part of rel.split(/[\\/]/).filter(Boolean)) {
    current = resolve(current, part);
    if (!lstatSync(current).isDirectory()) throw new Error('Parent alias changed');
  }
  if (!same(fstatSync(3), parent) || !same(lstatSync('.'), parent)
    || !same(lstatSync(parent.path), parent)) throw new Error('Parent identity changed');
}
function checkTarget() {
  const { name, target, before } = request;
  if (!target) {
    try { lstatSync(name); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    throw new Error('Target appeared');
  }
  const stat = fstatSync(4);
  const entry = lstatSync(name);
  if (!stat.isFile() || !entry.isFile() || !same(stat, target) || !same(entry, target)
    || stat.nlink !== 1 || stat.size > MAX_BYTES) throw new Error('Target changed');
  if (!readBytes(4).equals(Buffer.from(before, 'base64'))) throw new Error('Content changed');
}
function readBytes(fd) {
  const bytes = Buffer.alloc(MAX_BYTES + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
    if (!count) break;
    offset += count;
  }
  return bytes.subarray(0, offset);
}
function checkStage(bytes) {
  const held = fstatSync(tempFd); const entry = lstatSync(temp);
  if (!held.isFile() || !entry.isFile() || held.nlink !== 1 || !same(held, tempIdentity)
    || !same(entry, tempIdentity) || !readBytes(tempFd).equals(bytes)) throw new Error('Staging file changed');
}
try {
  request = JSON.parse(input);
  const { name, content, target } = request;
  if (typeof name !== 'string' || !name || name === '.' || /[\\/]/.test(name)
    || protectedPath(name) || typeof content !== 'string' || Buffer.byteLength(content) > MAX_BYTES) {
    throw new Error('Invalid commit');
  }
  checkParent(); checkTarget();
  temp = `.o8-pi-write-${randomUUID()}`;
  tempFd = openSync(temp, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  tempIdentity = fstatSync(tempFd);
  const bytes = Buffer.from(content);
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(tempFd, bytes, offset, bytes.length - offset, offset);
  if (target) fchmodSync(tempFd, fstatSync(4).mode & 0o777);
  fsyncSync(tempFd);
  checkTarget(); checkParent(); checkStage(bytes);
  // No await between descriptor/entry revalidation and publication. Never
  // truncate the approved inode: even a concurrent hard-link alias keeps its bytes.
  if (target) {
    const held = fstatSync(4); const entry = lstatSync(name);
    if (held.nlink !== 1 || !same(held, target) || !entry.isFile() || !same(entry, target)) {
      throw new Error('Target identity or link count changed');
    }
    renameSync(temp, name);
    temp = undefined;
  } else {
    // link is exclusive: a target that appears at publication is never overwritten.
    linkSync(temp, name);
  }
} catch {
  process.exitCode = 1;
} finally {
  if (tempFd !== undefined) closeSync(tempFd);
  if (temp && tempIdentity) {
    try {
      // If the directory has moved out of the workspace, leave the temp alone.
      checkParent();
      if (same(lstatSync(temp), tempIdentity)) unlinkSync(temp);
    } catch { /* Never follow a changed parent for cleanup. */ }
  }
}
