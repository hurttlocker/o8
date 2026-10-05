// Host-only commit helper. The inherited directory descriptor and cwd must agree
// before any side effect; all mutations use names relative to that pinned cwd,
// which follows the directory itself even if another process moves it.
//
// Concurrent same-user mutation (#3243):
// - Nothing at a name is overwritten. The approved target is moved aside under a
//   fresh random name and verified; the stage is published with an exclusive link
//   and verified in place (inode, link count, bytes, parent location).
// - Names are never removed after a separate check. An entry is first captured
//   under a fresh random name, then removed only when that destroys nothing (our
//   own inode, or an inode that keeps another name); anything else is put back
//   without overwriting.
// - Any uncommitted failure wipes the stage inode through its descriptor, so a
//   hard-link alias keeps no approved bytes.
// - The helper reports the stage identity and backup name on stdout, so the host
//   can run a recovery pass if a signal ends this process.
// Without directory-relative syscalls, a hostile process racing these random
// names within microseconds can still leave entries behind; see the PR notes.
import { randomUUID } from 'node:crypto';
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, ftruncateSync, linkSync, lstatSync,
  openSync, readlinkSync, readSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeSync,
} from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

const MAX_BYTES = 50_000;
const STAGE = /^\.o8-pi-write-[0-9a-f-]{36}$/;
const BACKUP = /^\.o8-pi-backup-[0-9a-f-]{36}$/;
const same = (a, b) => Boolean(a && b) && a.dev === b.dev && a.ino === b.ino;
const protectedPath = path => path.split(/[\\/]/).some(part => part === '..'
  || part.toLowerCase() === '.git' || part.toLowerCase().startsWith('.env'));
function entry(name) {
  try { return lstatSync(name); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function report(message) { writeSync(1, `${JSON.stringify(message)}\n`); }

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
let backup;
let aside;
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

// Move whatever holds a name to a fresh random name, so it can be judged without
// a check-then-unlink race. Returns null when the name is empty.
function capture(name) {
  const held = `.o8-pi-q-${randomUUID()}`;
  try { renameSync(name, held); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  return { name: held, stat: lstatSync(held) };
}
function discard(captured) {
  if (same(entry(captured.name), captured.stat)) unlinkSync(captured.name);
}
// Put a captured entry back without overwriting anything. Returns false when the
// name is taken or the entry cannot be recreated; it then stays where it is.
function putBack(captured, name) {
  const { stat } = captured;
  try {
    if (stat.isSymbolicLink()) symlinkSync(readlinkSync(captured.name), name);
    else if (stat.isFile()) {
      linkSync(captured.name, name);
      if (!same(entry(name), stat)) {
        // macOS link() follows a symlink swapped in at the source; that alias
        // names an inode with another name, so removing it destroys nothing.
        // Anything else that took the name goes back.
        const alias = capture(name);
        if (alias && alias.stat.nlink >= 2) discard(alias);
        else if (alias) putBack(alias, name);
        return false;
      }
    } else return false;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
  discard(captured);
  return true;
}
// Remove a name only if it still holds the given inode; put anything else back.
function removeIf(name, id) {
  const captured = capture(name);
  if (!captured) return;
  if (same(captured.stat, id)) discard(captured);
  else putBack(captured, name);
}

function probeLinks() {
  // Replacing moves the target aside and publishes with link(2). Refuse before
  // touching the target where hard links are unavailable.
  const probe = `.o8-pi-probe-${randomUUID()}`;
  linkSync(request.stage, probe);
  removeIf(probe, stageId);
}

async function commit() {
  const { name, target, before, stage } = request;
  checkParent(); checkTarget();
  await safePoint();
  stageFd = openSync(stage, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  stageId = fstatSync(stageFd);
  report({ stage: { dev: stageId.dev, ino: stageId.ino } });
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(stageFd, bytes, offset, bytes.length - offset, offset);
  fsyncSync(stageFd);
  if (target) probeLinks();
  await safePoint();
  checkTarget(); checkParent(); checkStage();
  // Publication. No await from here until it is verified or rolled back.
  if (target) {
    // A fresh name: nothing derived from the visible stage name can predict it.
    backup = `.o8-pi-backup-${randomUUID()}`;
    report({ backup });
    if (entry(backup)) throw new Error('Backup name taken');
    renameSync(name, backup);
    aside = lstatSync(backup);
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
  finish();
}
// After a verified publication: apply the target's mode (deferred so recovery can
// always reopen the stage), then remove the stage name and the replaced target.
function finish() {
  const { target, stage } = request;
  if (target) fchmodSync(stageFd, fstatSync(4).mode & 0o777);
  removeIf(stage, stageId);
  if (target && backup) removeIf(backup, target);
}

function restoreAside() {
  const current = entry(backup);
  if (!same(current, aside)) return;
  if (!putBack({ name: backup, stat: current }, request.name)) report({ kept: backup });
}
function rollback() {
  if (published) {
    // Remove the publication only when that destroys nothing: it is our stage
    // inode, or an inode that still has another name. Anything else, such as an
    // editor's save that replaced it, goes back to the name.
    const captured = capture(request.name);
    if (captured) {
      if (same(captured.stat, stageId) || captured.stat.nlink >= 2) discard(captured);
      else putBack(captured, request.name);
    }
  }
  if (aside) restoreAside();
}
function cleanupStage() {
  if (stageFd === undefined) return;
  // Wipe the approved bytes from every alias of an uncommitted stage.
  if (!committed) { try { ftruncateSync(stageFd, 0); } catch { /* Descriptor may be read-only in recovery. */ } }
  try { removeIf(request.stage, stageId); } catch { /* Relative to the pinned directory only. */ }
  closeSync(stageFd);
}

function openOurs(name, id) {
  for (const flags of [constants.O_RDWR, constants.O_RDONLY]) {
    let fd;
    // Non-blocking, so a FIFO swapped in at a name cannot stall recovery.
    try { fd = openSync(name, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { continue; }
    if (same(fstatSync(fd), id)) return fd;
    closeSync(fd);
    return undefined;
  }
  return undefined;
}
// After a signal ended the commit: finish a verified publication of our own
// inode, otherwise roll back. Ownership comes only from the identity the commit
// reported, never from what a name holds now. Exit 0 only when the approved
// bytes are published.
function recover() {
  const { name, stage, parent } = request;
  if (!same(fstatSync(3), parent) || !same(lstatSync('.'), parent)) throw new Error('Parent changed');
  stageId = request.stageId;
  backup = request.backup ?? undefined;
  stageFd = openOurs(name, stageId) ?? openOurs(stage, stageId);
  if (stageFd !== undefined && same(entry(name), stageId)) {
    const names = 1 + (same(entry(stage), stageId) ? 1 : 0);
    let inside = true;
    try { checkParent(); } catch { inside = false; }
    if (inside && fstatSync(stageFd).nlink === names && readBytes(stageFd).equals(bytes)) {
      committed = true;
      finish();
      return;
    }
    published = true;
  }
  // Whatever the commit moved aside goes back to the name.
  if (backup) aside = entry(backup) ?? undefined;
  throw new Error('Commit rolled back');
}

function validIdentity(value) {
  return Boolean(value) && Number.isSafeInteger(value.dev) && Number.isSafeInteger(value.ino);
}
try {
  request = JSON.parse(input);
  const { mode, name, content, stage } = request;
  if (!['commit', 'recover'].includes(mode) || typeof name !== 'string' || !name || name === '.'
    || /[\\/]/.test(name) || protectedPath(name) || typeof content !== 'string'
    || Buffer.byteLength(content) > MAX_BYTES || !STAGE.test(stage)
    || (mode === 'recover' && (!validIdentity(request.stageId)
      || (request.backup != null && !BACKUP.test(request.backup))))) {
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
