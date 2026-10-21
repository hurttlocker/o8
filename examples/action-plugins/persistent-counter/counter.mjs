#!/usr/bin/env node
import { constants, closeSync, fstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const directory = process.env.O8_PLUGIN_STATE_DIR;
if (!directory) throw new Error('The reviewed persistent state directory is required.');
const file = path.join(directory, 'counter.json');
let count = 0;
try {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64) throw new Error('Invalid counter file.');
    count = JSON.parse(readFileSync(fd, 'utf8')).count;
    if (!Number.isSafeInteger(count) || count < 0 || count >= Number.MAX_SAFE_INTEGER) throw new Error('Invalid counter value.');
  } finally { closeSync(fd); }
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const temporary = path.join(directory, `.counter-${randomUUID()}`);
try {
  writeFileSync(temporary, JSON.stringify({ count: count + 1 }), { flag: 'wx', mode: 0o600 });
  renameSync(temporary, file);
} finally { rmSync(temporary, { force: true }); }
console.log(`Counter: ${count + 1}`);
