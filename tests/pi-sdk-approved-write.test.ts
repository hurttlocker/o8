import { spawnSync } from 'node:child_process';
import { closeSync, constants, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function helperFixture(content: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-pi-write-helper-'))); roots.push(root);
  const workspace = join(root, 'workspace'); mkdirSync(workspace);
  const stat = lstatSync(workspace);
  const request = Buffer.from(JSON.stringify({ root: workspace, parent: { path: workspace,
    dev: stat.dev, ino: stat.ino, root: { dev: stat.dev, ino: stat.ino } },
    name: 'note.txt', target: null, before: null, content }));
  return { workspace, request };
}
const helper = fileURLToPath(new URL('../scripts/pi-sdk/approved-write.mjs', import.meta.url));
function runHelper(workspace: string, request: Buffer, injection: string, split = request.length) {
  const directory = openSync(workspace, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    return spawnSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { Readable } from 'node:stream';
      const bytes = Buffer.from(process.argv[2], 'base64');
      const split = Number(process.argv[3]);
      Object.defineProperty(process, 'stdin', { value: Readable.from([
        bytes.subarray(0, split), bytes.subarray(split),
      ]) });
      ${injection}
      await import(process.argv[1]);
    `, helper, request.toString('base64'), String(split)], {
      cwd: workspace, env: { NODE_ENV: 'production' }, timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe', directory, 'ignore'], encoding: 'utf8',
    });
  } finally { closeSync(directory); }
}

describe('approved write helper boundary', () => {
  it('preserves approved UTF-8 when stdin splits a multibyte character', () => {
    const { workspace, request } = helperFixture('hello π');
    const split = request.indexOf(Buffer.from('π')) + 1;
    const result = runHelper(workspace, request, '', split);
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
    expect(readFileSync(join(workspace, 'note.txt'), 'utf8')).toBe('hello π');
  });
  it.each(['replace', 'modify', 'link'])('refuses a staging %s after sync before publishing approved bytes', mutation => {
    const { workspace, request } = helperFixture('approved bytes');
    const result = runHelper(workspace, request, `
      const sync = fs.fsyncSync;
      fs.fsyncSync = fd => {
        sync(fd);
        const stage = fs.readdirSync('.').find(name => name.startsWith('.o8-pi-write-'));
        if (${JSON.stringify(mutation)} === 'replace') {
          fs.renameSync(stage, stage + '.held'); fs.writeFileSync(stage, 'replacement never approved');
        } else if (${JSON.stringify(mutation)} === 'modify') {
          fs.writeFileSync(stage, 'modified bytes');
        } else fs.linkSync(stage, stage + '.alias');
      };
      syncBuiltinESMExports();
    `);
    expect(result.error).toBeUndefined(); expect(result.status).toBe(1);
    expect(() => lstatSync(join(workspace, 'note.txt'))).toThrow();
  });
});
