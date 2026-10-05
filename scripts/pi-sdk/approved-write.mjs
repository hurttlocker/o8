// Host-only commit helper. The inherited directory descriptor and cwd must agree
// before any side effect; all mutations use names relative to that pinned cwd,
// which follows the directory itself even if another process moves it.
//
// Concurrent same-user mutation (#3243): nothing at the target name is ever
// overwritten. The approved target is moved aside and verified, the stage is
// published with an exclusive link and verified in place, and any failure
// rolls back, wipes the stage inode (so a hard-link alias keeps no approved
// bytes) and removes the stage.
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, ftruncateSync, linkSync, lstatSync,
  openSync, readSync, realpathSync, renameSync, unlinkSync, writeSync,
} from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

const MAX_BYTES = 50_000;
const STAGE = /^\.o8-pi-write-[0-9a-f-]{36}$/;
const BACKUP = /^\.o8-pi-backup-[0-9a-f-]{36}$/;
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const protectedPath = path => path.split(/[\\/]/).some(part => part === '..'
  || part.toLowerCase() === '.git' || part.toLowerCase().startsWith('.env'));
function entry(name) {
  try { return lstatSync(name); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// The host sends SIGTERM to abort or on timeout. Before publication the helper
// stops at its next safe point and cleans up; publication itself runs to
// completion or rollback without yielding.
let aborted = false;
process.on('SIGTERM', () => { aborted = true; });
async function safePoint() {
  await new Promise(resolve => setImmediate(resolve));
  if (aborted) throw new Error('Aborted');
}

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) {
  input += chunk;
  if (Buffer.byteLength(input) > MAX_BYTES * 10) process.exit(1);
}

let request;
let bytes;
let stageFd;
let stageId;
let movedAside = false;
let published = false;
let committed = false;

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
    if (entry(name)) throw new Error('Target appeared');
    return;
  }
  const stat = fstatSync(4);
  const current = lstatSync(name);
  if (!stat.isFile() || !current.isFile() || !same(stat, target) || !same(current, target)
    || stat.nlink !== 1 || stat.size > MAX_BYTES) throw new Error('Target changed');
  if (!readBytes(4).equals(Buffer.from(before, 'base64'))) throw new Error('Content changed');
}
function readBytes(fd) {
  const buffer = Buffer.alloc(MAX_BYTES + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
    if (!count) break;
    offset += count;
  }
  return buffer.subarray(0, offset);
}
function checkStage() {
  const held = fstatSync(stageFd); const current = lstatSync(request.stage);
  if (!held.isFile() || !current.isFile() || held.nlink !== 1 || !same(held, stageId)
    || !same(current, stageId) || !readBytes(stageFd).equals(bytes)) throw new Error('Staging file changed');
}

async function commit() {
  const { name, target, before, stage, backup } = request;
  checkParent(); checkTarget();
  await safePoint();
  stageFd = openSync(stage, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  stageId = fstatSync(stageFd);
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(stageFd, bytes, offset, bytes.length - offset, offset);
  if (target) fchmodSync(stageFd, fstatSync(4).mode & 0o777);
  fsyncSync(stageFd);
  await safePoint();
  checkTarget(); checkParent(); checkStage();
  // Publication. No await from here until it is verified or rolled back.
  if (target) {
    // Move the approved target aside instead of renaming over it: whatever a
    // concurrent process put at the name is captured and verified, never lost.
    renameSync(name, backup);
    movedAside = true;
    const aside = lstatSync(backup);
    if (!aside.isFile() || !same(aside, target) || aside.nlink !== 1
      || !readBytes(4).equals(Buffer.from(before, 'base64'))) throw new Error('Target changed');
  }
  // link is exclusive: a file that appears at the name is never overwritten.
  linkSync(stage, name);
  published = true;
  const out = lstatSync(name); const held = fstatSync(stageFd);
  if (!same(out, stageId) || held.nlink !== 2 || !readBytes(stageFd).equals(bytes)) {
    throw new Error('Publication changed');
  }
  checkParent();
  committed = true;
  const current = entry(stage);
  if (current && same(current, stageId)) unlinkSync(stage);
  const aside = target && entry(backup);
  if (aside && same(aside, target)) unlinkSync(backup);
}

function restoreAside() {
  const { name, backup } = request;
  const aside = entry(backup);
  if (!aside || entry(name)) return; // Never overwrite whatever now holds the name.
  if (!aside.isFile()) { renameSync(backup, name); return; }
  linkSync(backup, name);
  // macOS link() follows a symlink swapped in at the source: drop that alias.
  if (!same(lstatSync(name), aside)) { unlinkSync(name); return; }
  if (same(lstatSync(backup), aside)) unlinkSync(backup);
}
function rollback() {
  const { name, stage } = request;
  if (published) {
    // Remove only a publication another name still holds: the stage inode, or
    // whatever the stage pathname held when it was linked.
    const out = entry(name); const current = entry(stage);
    if (out && (same(out, stageId) || (current && same(out, current)))) unlinkSync(name);
  }
  if (movedAside) restoreAside();
}
function cleanupStage() {
  if (stageFd === undefined) return;
  try {
    // Wipe the approved bytes from every alias unless they are the publication.
    const out = entry(request.name);
    if (!committed && !(out && same(out, stageId))) ftruncateSync(stageFd, 0);
  } catch { /* The descriptor still closes below. */ }
  try {
    const current = entry(request.stage);
    if (current && same(current, stageId)) unlinkSync(request.stage);
  } catch { /* Relative to the pinned directory; nothing else is touched. */ }
  closeSync(stageFd);
}

// After the host killed an unresponsive commit: finish a verified publication,
// otherwise restore the target and remove the stage. Exit 0 only when the
// approved bytes are published.
function recover() {
  const { name, target, stage, backup, parent } = request;
  if (!same(fstatSync(3), parent) || !same(lstatSync('.'), parent)) throw new Error('Parent changed');
  const current = entry(stage); const out = entry(name);
  let finished = false;
  if (current?.isFile() && out && same(out, current)) {
    const fd = openSync(stage, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      let inside = true;
      try { checkParent(); } catch { inside = false; }
      if (inside && same(fstatSync(fd), current) && current.nlink === 2 && readBytes(fd).equals(bytes)) {
        unlinkSync(stage);
        const aside = target && entry(backup);
        if (aside && same(aside, target)) unlinkSync(backup);
        finished = true;
      } else {
        unlinkSync(name);
        ftruncateSync(fd, 0);
      }
    } finally { closeSync(fd); }
  }
  if (finished) return;
  if (target) restoreAside();
  const stale = entry(stage);
  if (stale?.isFile()) {
    const fd = openSync(stage, constants.O_RDWR | constants.O_NOFOLLOW);
    try { if (same(fstatSync(fd), stale)) ftruncateSync(fd, 0); } finally { closeSync(fd); }
    unlinkSync(stage);
  }
  throw new Error('Commit rolled back');
}

try {
  request = JSON.parse(input);
  const { mode, name, content, stage, backup } = request;
  if (!['commit', 'recover'].includes(mode) || typeof name !== 'string' || !name || name === '.'
    || /[\\/]/.test(name) || protectedPath(name) || typeof content !== 'string'
    || Buffer.byteLength(content) > MAX_BYTES || !STAGE.test(stage) || !BACKUP.test(backup)) {
    throw new Error('Invalid commit');
  }
  bytes = Buffer.from(content);
  if (mode === 'recover') recover();
  else await commit();
} catch {
  if (!committed) {
    process.exitCode = 1;
    try { rollback(); } catch { /* Leave anything that cannot be verified. */ }
  }
} finally {
  cleanupStage();
}
