import {
  mkdtempSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openWorkspaceFile, WorkspaceFileError } from './workspace-file';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('openWorkspaceFile', () => {
  it('fails closed when the path inode changes after the descriptor opens', async () => {
    const root = mkdtempSync(join(tmpdir(), 'o8-workspace-file-swap-'));
    tempDirs.push(root);
    mkdirSync(join(root, 'src'));
    const target = join(root, 'src', 'note.txt');
    const displaced = join(root, 'src', 'note.original.txt');
    writeFileSync(target, 'original\n', 'utf-8');

    const operation = openWorkspaceFile(root, 'src/note.txt', 'read', {
      afterOpen: () => {
        renameSync(target, displaced);
        writeFileSync(target, 'replacement\n', 'utf-8');
      },
    });

    await expect(operation).rejects.toMatchObject({
      code: 'workspace_identity_mismatch',
      status: 409,
    } satisfies Partial<WorkspaceFileError>);
  });
});
