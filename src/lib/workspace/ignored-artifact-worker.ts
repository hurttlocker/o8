import { ARTIFACT_PROTOCOL_SCRIPT } from '@/lib/workspace/ignored-artifact-protocol';

const ARTIFACT_NODE_SCRIPT = ARTIFACT_PROTOCOL_SCRIPT + String.raw`
const workerScript = process.argv[1];
const maxDirectoryDepth = 32;
const children = new Map();
let context;
let rootFd;
let handlingRequest = false;
process.stdin.on('end', () => {
  if (handlingRequest) for (const child of children.values()) child.client.abort();
});
function verifyContext() {
  const actual = fs.lstatSync('.');
  const pinned = fs.fstatSync(rootFd);
  const canonical = fs.realpathSync('.');
  const inside = path.relative(context.rootCanonical, canonical);
  if (!actual.isDirectory() || actual.isSymbolicLink() || actual.dev !== context.identity.device
    || actual.ino !== context.identity.inode || pinned.dev !== actual.dev || pinned.ino !== actual.ino
    || canonical !== context.identity.canonicalPath || inside.startsWith('..') || path.isAbsolute(inside)) {
    throw new Error('Captured artifact directory ownership changed.');
  }
}
function verifyChild(part, child) {
  const named = fs.lstatSync(part);
  const pinned = fs.fstatSync(child.fd);
  if (!named.isDirectory() || named.isSymbolicLink() || named.dev !== child.identity.device
    || named.ino !== child.identity.inode || pinned.dev !== named.dev || pinned.ino !== named.ino) {
    throw new Error('Artifact ancestor changed.');
  }
}
async function enterChild(part, create, onEvent) {
  if (children.has(part)) {
    const child = children.get(part); verifyChild(part, child); return child;
  }
  const canonicalPath = path.join(context.identity.canonicalPath, part);
  if (path.relative(context.rootCanonical, canonicalPath).split(path.sep).length > maxDirectoryDepth) {
    throw new Error('Artifact directory nesting exceeds its worker bound.');
  }
  // Keep one branch per level; wait for every old descendant before admitting a sibling.
  await closeChildren();
  let named;
  try { named = fs.lstatSync(part); }
  catch (error) {
    if (error.code !== 'ENOENT' || !create) throw error;
    fs.mkdirSync(part, 0o700); syncCurrentDirectory(); named = fs.lstatSync(part);
  }
  if (!named.isDirectory() || named.isSymbolicLink()) throw new Error('Artifact ancestor is not a regular directory.');
  const fd = fs.openSync(part, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  let client;
  try {
    const pinned = fs.fstatSync(fd);
    if (pinned.dev !== named.dev || pinned.ino !== named.ino) throw new Error('Artifact ancestor changed before delegation.');
    const identity = { device: pinned.dev, inode: pinned.ino, canonicalPath };
    client = await connectArtifactNode(workerScript, part, identity, context.rootCanonical, context.deadline, onEvent);
    const child = { fd, identity, client };
    verifyChild(part, child); children.set(part, child); return child;
  } catch (error) {
    try { if (client) await client.close(); } finally { fs.closeSync(fd); }
    throw error;
  }
}
async function closeChildren() {
  const results = await Promise.allSettled([...children.values()].map(async (child) => {
    try { await child.client.close(); } finally { fs.closeSync(child.fd); }
  }));
  children.clear();
  if (results.some((result) => result.status === 'rejected')) throw new Error('Artifact directory children did not close cleanly.');
}
function captureLeaf(leaf, request) {
  const stat = fs.lstatSync(leaf);
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
    throw new Error('Unique ignored content has an unsupported filesystem node.');
  }
  const base = { path: request.originalPath, mode: stat.mode & 0o777, device: stat.dev, inode: stat.ino };
  if (stat.isDirectory()) {
    return { stat: statRecord(stat), names: fs.readdirSync(leaf).sort(),
      entry: { ...base, kind: 'directory', bytes: 0, sha256: null, content: null } };
  }
  if (!request.copiedBound && /^\.env(?:\.|$)/.test(path.basename(request.originalPath))) {
    throw new Error('An unbound ignored environment file requires a privacy decision.');
  }
  if (stat.size > 16 * 1024 * 1024 || stat.size > request.remainingBytes) {
    throw new Error('Unique ignored artifact bytes exceed the bounded preservation budget.');
  }
  const fd = fs.openSync(leaf, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(fd);
    if (!same(stat, opened)) throw new Error('Ignored artifact file changed before capture.');
    const content = readAt(fd, opened.size);
    const repeated = readAt(fd, opened.size);
    const after = fs.fstatSync(fd);
    const named = fs.lstatSync(leaf);
    if (!same(opened, after) || named.dev !== after.dev || named.ino !== after.ino || !content.equals(repeated)) {
      throw new Error('Ignored artifact file changed during capture.');
    }
    const sha256 = hash(content);
    if (request.copiedBound) {
      if (request.copiedHash === null || request.copiedHash !== sha256) throw new Error('Copied environment binding changed.');
      return { stat: statRecord(stat), entry: null };
    }
    return { stat: statRecord(stat), entry: { ...base, kind: 'file', bytes: content.length,
      sha256, content: content.toString('base64') } };
  } finally { fs.closeSync(fd); }
}
async function restoreLeaf(leaf, request, onEvent) {
  const entry = request.entry;
  const owner = request.owner;
  const content = Buffer.from(entry.content, 'base64');
  if (content.length !== entry.bytes || content.toString('base64') !== entry.content
    || hash(content) !== entry.sha256 || content.length > 16 * 1024 * 1024) throw new Error('Artifact content receipt is invalid.');
  const flags = owner ? fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
    : fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
  let fd = fs.openSync(leaf, flags, 0o600);
  try {
    const before = fs.fstatSync(fd);
    const named = fs.lstatSync(leaf);
    if (!before.isFile() || before.nlink !== 1 || named.dev !== before.dev || named.ino !== before.ino
      || (owner && (before.dev !== owner.device || before.ino !== owner.inode))) throw new Error('Artifact destination identity changed.');
    if (before.size > content.length) throw new Error('A previously owned restore file grew beyond its bounded receipt.');
    const existing = readAt(fd, before.size);
    if (!same(before, fs.fstatSync(fd)) || !same(before, fs.lstatSync(leaf))) throw new Error('Artifact destination changed during verification.');
    if (owner && (!existing.equals(content.subarray(0, existing.length))
      || (owner.phase === 'complete' && (hash(existing) !== entry.sha256 || (before.mode & 0o777) !== entry.mode)))) {
      throw new Error('A previously owned restore file was modified; no overwrite was applied.');
    }
    if (owner && owner.phase === 'complete') return null;
    const event = (phase) => ({ path: entry.path, device: before.dev, inode: before.ino,
      phase, sha256: entry.sha256, bytes: entry.bytes });
    if (owner && existing.equals(content) && (before.mode & 0o777) === entry.mode) {
      fs.fsyncSync(fd);
      if (!same(before, fs.fstatSync(fd)) || !same(before, fs.lstatSync(leaf))) throw new Error('Prepared artifact changed during read-only recovery.');
      await onEvent(event('complete')); return null;
    }
    if (owner) {
      const writable = fs.openSync(leaf, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const captured = fs.fstatSync(writable);
      if (!same(before, captured) || !same(before, fs.lstatSync(leaf))) {
        fs.closeSync(writable); throw new Error('Prepared artifact changed before retry publication.');
      }
      fs.closeSync(fd); fd = writable;
    }
    fs.fsyncSync(fd); syncCurrentDirectory();
    await onEvent(event('prepared'));
    verifyContext();
    if (!same(before, fs.fstatSync(fd)) || !same(before, fs.lstatSync(leaf))) throw new Error('Prepared artifact changed after its acknowledgement.');
    let offset = 0;
    while (offset < content.length) {
      const count = fs.writeSync(fd, content, offset, content.length - offset, offset);
      if (!count) throw new Error('Artifact publication write was incomplete.');
      offset += count;
    }
    fs.ftruncateSync(fd, content.length); fs.fchmodSync(fd, entry.mode); fs.fsyncSync(fd);
    const after = fs.fstatSync(fd);
    const published = fs.lstatSync(leaf);
    if (after.dev !== before.dev || after.ino !== before.ino || after.nlink !== 1
      || published.dev !== after.dev || published.ino !== after.ino || hash(readAt(fd, after.size)) !== entry.sha256) {
      throw new Error('Artifact publication did not match its receipt.');
    }
    await onEvent(event('complete')); return null;
  } finally { fs.closeSync(fd); }
}
async function route(request, onEvent) {
  verifyContext();
  const parts = safeRelative(request.path).split('/');
  const leaf = parts.pop();
  let result;
  if (parts.length) {
    const part = parts.shift();
    let child;
    try { child = await enterChild(part, ['create-directory', 'restore-file'].includes(request.action), onEvent); }
    catch (error) { if (error.code === 'ENOENT' && request.action === 'inspect') return null; throw error; }
    result = await child.client.request({ ...request, path: [...parts, leaf].join('/') }, onEvent);
    verifyChild(part, child);
  } else if (request.action === 'inspect') {
    try { result = statRecord(fs.lstatSync(leaf)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; result = null; }
  } else if (request.action === 'capture') {
    result = captureLeaf(leaf, request);
  } else if (request.action === 'verify-directory') {
    const after = fs.lstatSync(leaf);
    if (!after.isDirectory() || after.isSymbolicLink() || !same(request.stat, after)
      || JSON.stringify(request.names) !== JSON.stringify(fs.readdirSync(leaf).sort())) {
      throw new Error('Ignored artifact directory changed during capture.');
    }
    result = null;
  } else if (request.action === 'create-directory') {
    try { fs.lstatSync(leaf); }
    catch (error) { if (error.code !== 'ENOENT') throw error; fs.mkdirSync(leaf, 0o700); syncCurrentDirectory(); }
    const stat = fs.lstatSync(leaf);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Artifact directory destination changed.');
    result = null;
  } else if (request.action === 'restore-file') {
    result = await restoreLeaf(leaf, request, onEvent);
  } else throw new Error('Artifact node action is invalid.');
  verifyContext();
  return result;
}
(async () => {
  context = JSON.parse(await nextLine());
  rootFd = fs.openSync('.', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  verifyContext();
  if (!Number.isSafeInteger(context.deadline) || context.deadline <= Date.now()
    || context.deadline > Date.now() + 30_000) throw new Error('Artifact node deadline is invalid.');
  const timer = setTimeout(() => process.exit(78), context.deadline - Date.now() + 1000);
  try {
    process.stdout.write(JSON.stringify({ type: 'ready', identity: context.identity }) + '\n');
    let previousSequence = 0;
    while (true) {
      let line;
      try { line = await nextLine(); }
      catch (error) { if (inputEnded) break; throw error; }
      const message = JSON.parse(line);
      if (message.type !== 'request' || !Number.isSafeInteger(message.sequence)
        || message.sequence !== previousSequence + 1 || Date.now() >= context.deadline) throw new Error('Artifact node request is stale.');
      previousSequence = message.sequence;
      handlingRequest = true;
      const onEvent = async (event) => {
        process.stdout.write(JSON.stringify({ type: 'event', sequence: message.sequence, event }) + '\n');
        if (await nextLine() !== 'ok') throw new Error('Artifact ownership receipt was not persisted.');
      };
      const result = await route(message.request, onEvent);
      process.stdout.write(JSON.stringify({ type: 'result', sequence: message.sequence, result }) + '\n');
      handlingRequest = false;
    }
  } finally { clearTimeout(timer); await closeChildren(); fs.closeSync(rootFd); }
  process.exit(0);
})().catch(() => {
  process.stderr.write('Captured artifact directory operation refused.\n');
  process.exit(78);
});
`;

export function artifactNodeScript(): string {
  return ARTIFACT_NODE_SCRIPT;
}
