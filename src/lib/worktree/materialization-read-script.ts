export const PINNED_WORKSPACE_PATH_SCRIPT = String.raw`
function safeRelative(value) {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split('/').includes('..')) {
    throw new Error('Pinned workspace path is unsafe.');
  }
  return normalized;
}

async function waitForStep(name) {
  if (process.env.O8_PINNED_STEP_HANDSHAKE !== '1') return;
  process.stdout.write('O8_PINNED_STEP ' + Buffer.from(name).toString('base64url') + '\n');
  await new Promise((resolve, reject) => {
    process.stdin.once('data', () => {
      process.stdin.pause();
      resolve();
    });
    process.stdin.once('error', reject);
    process.stdin.resume();
  });
}

async function prepareParent(relative, createMissing = true) {
  const parts = safeRelative(relative).split('/');
  const leaf = parts.pop();
  const canonicalRoot = fs.realpathSync('.');
  for (const part of parts) {
    let entry;
    try {
      entry = fs.lstatSync(part);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!createMissing) throw error;
      fs.mkdirSync(part);
      entry = fs.lstatSync(part);
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error('Pinned workspace destination has an unsafe ancestor.');
    }
    await waitForStep(part);
    process.chdir(part);
    const captured = fs.lstatSync('.');
    const canonical = fs.realpathSync('.');
    const relativeCanonical = path.relative(canonicalRoot, canonical);
    if (!captured.isDirectory() || captured.isSymbolicLink()
      || captured.dev !== entry.dev || captured.ino !== entry.ino
      || relativeCanonical.startsWith('..') || path.isAbsolute(relativeCanonical)) {
      throw new Error('Pinned workspace ancestor changed during capture.');
    }
  }
  return { parent: '.', leaf, target: leaf };
}

function readExactHandle(handle, size) {
  const content = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const read = fs.readSync(handle, content, offset, size - offset, offset);
    if (read === 0) throw new Error('Pinned workspace file ended before its receipt.');
    offset += read;
  }
  return content;
}

`;

export const PINNED_WORKSPACE_READ_SCRIPT = String.raw`
async function readPinnedEntry(operation, relative, limitArg) {
  let code = 0;
  let stdout = '';
  let prepared;
  try {
    prepared = await prepareParent(relative, operation !== 'read' && operation !== 'inspect-entry');
  } catch (error) {
    if ((operation === 'read' || operation === 'inspect-entry') && error.code === 'ENOENT') {
      code = 44;
      return { code, stdout };
    }
    throw error;
  }
  if (operation === 'read') {
    try {
      const handle = fs.openSync(prepared.target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const identity = fs.fstatSync(handle);
        if (!identity.isFile() || identity.nlink !== 1) {
          throw new Error('Pinned workspace target is not an exclusive regular file.');
        }
        const limit = limitArg === undefined ? Infinity : Number(limitArg);
        if (!Number.isSafeInteger(identity.size) || identity.size > limit) {
          throw new Error('Pinned workspace metadata exceeds the automatic read allowance.');
        }
        const content = readExactHandle(handle, identity.size);
        const after = fs.fstatSync(handle);
        if (after.size !== identity.size || after.mtimeMs !== identity.mtimeMs) {
          throw new Error('Pinned workspace metadata changed during bounded read.');
        }
        stdout = JSON.stringify({
          content: content.toString('base64'),
          device: identity.dev,
          inode: identity.ino,
          canonicalPath: fs.realpathSync(prepared.target),
        });
      } finally {
        fs.closeSync(handle);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      code = 44;
    }
    return { code, stdout };
  }
  if (operation === 'inspect-entry') {
    try {
      const entry = fs.lstatSync(prepared.target);
      const kind = entry.isSymbolicLink() ? 'symlink'
        : entry.isDirectory() ? 'directory'
        : entry.isFile() ? 'file'
        : 'other';
      stdout = JSON.stringify({ kind, device: entry.dev, inode: entry.ino });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      code = 44;
    }
    return { code, stdout };
  }
  throw new Error('Pinned workspace read operation is unsupported.');
}
`;
