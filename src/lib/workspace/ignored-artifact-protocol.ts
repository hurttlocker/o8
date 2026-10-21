// The parent keeps every directory descriptor until its captured child exits.
// Requests are serial; restore acknowledgements reach the file writer only
// after the application persists the existing ownership receipt.
export const ARTIFACT_PROTOCOL_SCRIPT = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
let inputBuffer = '';
let inputBytes = 0;
const inputLines = [];
let inputReader = null;
let inputEnded = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  inputBytes += Buffer.byteLength(chunk);
  if (inputBytes > 64 * 1024 * 1024) process.exit(78);
  inputBuffer += chunk;
  let newline;
  while ((newline = inputBuffer.indexOf('\n')) >= 0) {
    const line = inputBuffer.slice(0, newline);
    inputBuffer = inputBuffer.slice(newline + 1);
    if (inputReader) { const reader = inputReader; inputReader = null; reader.resolve(line); }
    else inputLines.push(line);
  }
});
process.stdin.on('end', () => {
  inputEnded = true;
  if (inputReader) { inputReader.reject(new Error('Artifact request input ended.')); inputReader = null; }
});
function nextLine() {
  if (inputLines.length) return Promise.resolve(inputLines.shift());
  if (inputEnded) return Promise.reject(new Error('Artifact request input ended.'));
  return new Promise((resolve, reject) => { inputReader = { resolve, reject }; });
}
function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0')
    || path.posix.isAbsolute(value) || value.split('/').some((part) => !part || part === '.' || part === '..' || part === '.git')) {
    throw new Error('Artifact path is unsafe.');
  }
  return value;
}
function same(before, after) {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mode === after.mode && before.nlink === after.nlink
    && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}
function statRecord(stat) {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mode: stat.mode, nlink: stat.nlink,
    mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
    kind: stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other' };
}
function hash(content) { return crypto.createHash('sha256').update(content).digest('hex'); }
function readAt(fd, size) {
  const content = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = fs.readSync(fd, content, offset, size - offset, offset);
    if (!count) throw new Error('Artifact file changed during descriptor read.');
    offset += count;
  }
  return content;
}
function syncCurrentDirectory() {
  const fd = fs.openSync('.', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
async function connectArtifactNode(script, cwd, identity, rootCanonical, deadline, onEvent) {
  if (Date.now() >= deadline) throw new Error('Artifact operation time bound was exceeded.');
  const child = spawn(process.execPath, ['-e', script, script], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let readyResolve, readyReject, endResolve;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const ended = new Promise((resolve) => { endResolve = resolve; });
  let readySeen = false;
  let closing = false;
  let failure = null;
  let active = null;
  let sequence = 0;
  let output = '';
  let outputBytes = 0;
  let pending = Promise.resolve();
  function fail(error) {
    if (!failure) failure = error;
    readyReject(error);
    if (active) { active.reject(error); active = null; }
    child.stdin.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    outputBytes += Buffer.byteLength(chunk);
    if (outputBytes > 64 * 1024 * 1024) { fail(new Error('Artifact node output exceeded its byte bound.')); return; }
    output += chunk;
    let newline;
    while ((newline = output.indexOf('\n')) >= 0) {
      const line = output.slice(0, newline);
      output = output.slice(newline + 1);
      pending = pending.then(async () => {
        const message = JSON.parse(line);
        if (message.type === 'ready') {
          if (readySeen || message.identity.device !== identity.device || message.identity.inode !== identity.inode
            || message.identity.canonicalPath !== identity.canonicalPath) throw new Error('Artifact node ownership changed.');
          readySeen = true; readyResolve(); return;
        }
        if (!active || message.sequence !== active.sequence) throw new Error('Artifact node returned a stale receipt.');
        if (message.type === 'event') {
          const event = message.event;
          const entry = active.request.entry;
          if (active.request.action !== 'restore-file' || !entry || event.path !== entry.path
            || event.sha256 !== entry.sha256 || event.bytes !== entry.bytes
            || !['prepared', 'complete'].includes(event.phase)
            || !Number.isSafeInteger(event.device) || !Number.isSafeInteger(event.inode)) {
            throw new Error('Artifact node returned an unrelated ownership receipt.');
          }
          await active.onEvent(event);
          child.stdin.write('ok\n');
        } else if (message.type === 'result') {
          const current = active; active = null; current.resolve(message.result);
        } else throw new Error('Artifact node returned an unrecognized receipt.');
      }).catch(fail);
    }
  });
  child.stderr.resume();
  child.on('error', fail);
  child.on('close', (code) => {
    if (!closing) fail(new Error('Captured artifact node exited before close.'));
    endResolve(code);
  });
  child.stdin.on('error', fail);
  child.stdin.write(JSON.stringify({ identity, rootCanonical, deadline }) + '\n');
  try { await ready; }
  catch (error) { closing = true; child.stdin.destroy(); await ended; throw error; }
  return {
    request(request, handleEvent = onEvent) {
      if (failure || closing || active || Date.now() >= deadline) throw failure || new Error('Artifact node request is unavailable.');
      return new Promise((resolve, reject) => {
        active = { sequence: ++sequence, request, onEvent: handleEvent, resolve, reject };
        child.stdin.write(JSON.stringify({ type: 'request', sequence, request }) + '\n');
      });
    },
    async close() {
      closing = true;
      child.stdin.end();
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      }, Math.max(50, Math.min(1000, deadline - Date.now())));
      try {
        const code = await ended;
        await pending;
        if (code !== 0 && !failure) throw new Error('Captured artifact node did not close cleanly.');
      } finally { clearTimeout(timer); }
    },
    abort() { fail(new Error('Artifact node parent input ended during a request.')); },
  };
}
`;
