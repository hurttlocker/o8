import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { OwnedSessionRecord } from './types';

/** Refuse process creation until both the attempt journal and its directory are synced. */
export function saveRestrictedOwnedSession(file: string, session: OwnedSessionRecord): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, `${JSON.stringify(session)}\n`); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temporary, file);
    for (const directory of [dirname(file), dirname(dirname(file))]) {
      const directoryFd = openSync(directory, 'r');
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    }
  } finally { rmSync(temporary, { force: true }); }
}
