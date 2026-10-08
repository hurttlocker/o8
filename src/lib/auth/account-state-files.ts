import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

function syncDirectory(directory: string): void {
  if (process.platform === 'win32') return;
  const fd = openSync(directory, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function writeAccountFile(file: string, contents: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try { writeFileSync(fd, contents); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, file);
    syncDirectory(dirname(file));
  } finally { rmSync(temporary, { force: true }); }
}
export function removeAccountFile(file: string): void {
  rmSync(file, { force: true });
  syncDirectory(dirname(file));
}
