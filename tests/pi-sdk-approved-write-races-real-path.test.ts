import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { executePiTool } from '@/lib/pi/sdk/tools';
import { commitPiWrite } from '@/lib/pi/sdk/approved-write';

// Each test installs a wrapper as the packaged approved-write helper. The wrapper
// performs one concurrent same-user mutation at an exact filesystem call inside
// the real helper, then the real helper continues unchanged (#3243).
const realHelper = fileURLToPath(new URL('../scripts/pi-sdk/approved-write.mjs', import.meta.url));
const WRAPPER = `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const dir = new URL('.', import.meta.url);
const plan = JSON.parse(fs.readFileSync(new URL('plan.json', dir), 'utf8'));
const real = { renameSync: fs.renameSync, linkSync: fs.linkSync, writeSync: fs.writeSync, fsyncSync: fs.fsyncSync };
const stage = () => fs.readdirSync('.').find(name => name.startsWith('.o8-pi-write-') && !name.endsWith('.held'));
function act() {
  const fired = new URL('fired', dir);
  if (fs.existsSync(fired)) return;
  fs.writeFileSync(fired, '');
  if (plan.action === 'move-parent-outside') real.renameSync(plan.parent, plan.outside);
  else if (plan.action === 'link-stage-outside') real.linkSync(stage(), plan.alias);
  else if (plan.action === 'replace-stage') {
    const name = stage(); real.renameSync(name, name + '.held'); fs.writeFileSync(name, 'unapproved');
  } else if (plan.action === 'edit-stage') fs.writeFileSync(stage(), 'unapproved edit');
  else if (plan.action === 'replace-target') {
    real.renameSync(plan.name, plan.name + '.moved'); fs.writeFileSync(plan.name, 'concurrent');
  } else if (plan.action === 'block') {
    fs.writeFileSync(new URL('reached', dir), '');
    const cell = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(new URL('go', dir))) Atomics.wait(cell, 0, 0, 20);
  } else if (plan.action === 'die') process.kill(process.pid, 'SIGKILL');
  else if (plan.action === 'hang') {
    fs.writeFileSync(new URL('reached', dir), '');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
}
const touchesName = (...paths) => paths.includes(plan.name);
if (plan.at === 'publish') {
  const at = call => (from, to) => {
    const hit = touchesName(from, to);
    if (hit && !plan.after) act();
    const result = call(from, to);
    if (hit && plan.after) act();
    return result;
  };
  fs.renameSync = at(real.renameSync);
  fs.linkSync = at(real.linkSync);
} else if (plan.at === 'stage-write') {
  fs.writeSync = (...args) => { act(); return real.writeSync(...args); };
} else if (plan.at === 'fsync') {
  fs.fsyncSync = fd => { real.fsyncSync(fd); act(); };
}
syncBuiltinESMExports();
await import(plan.helper);
`;

type At = 'publish' | 'stage-write' | 'fsync';
type Action = 'move-parent-outside' | 'link-stage-outside' | 'replace-stage' | 'edit-stage' | 'replace-target' | 'block' | 'hang' | 'die';
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(original: string | null, at: At, action: Action, after = false) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'o8-pi-write-race-'))); roots.push(base);
  const workspace = join(base, 'workspace');
  const parent = join(workspace, 'sub');
  mkdirSync(parent, { recursive: true });
  if (original !== null) { writeFileSync(join(parent, 'note.txt'), original); chmodSync(join(parent, 'note.txt'), 0o640); }
  const helperDir = join(base, 'helper'); mkdirSync(helperDir);
  writeFileSync(join(helperDir, 'approved-write.mjs'), WRAPPER);
  const outside = join(base, 'outside-sub');
  const alias = join(base, 'outside-alias');
  writeFileSync(join(helperDir, 'plan.json'), JSON.stringify({ helper: realHelper, at, action, after, name: 'note.txt', parent, outside, alias }));
  vi.stubEnv('O8_PACKAGED_APP', '1');
  vi.stubEnv('O8_PI_SDK_DIR', helperDir);
  return { base, workspace, parent, outside, alias, helperDir };
}
function write(workspace: string, signal = new AbortController().signal) {
  return executePiTool(workspace, { name: 'write_file', args: { path: 'sub/note.txt', content: 'approved bytes' } },
    async () => true, signal);
}
function leftovers(dir: string) {
  return readdirSync(dir).filter(name => name.startsWith('.o8-pi-'));
}
function fired(helperDir: string) { return existsSync(join(helperDir, 'fired')); }
async function waitFor(file: string) {
  for (let i = 0; i < 500 && !existsSync(file); i++) await sleep(10);
  expect(existsSync(file)).toBe(true);
}

describe('approved writes under concurrent workspace mutation', () => {
  it.each([null, 'original'])('still publishes approved bytes without interference (target %s)', async original => {
    const f = fixture(original, 'publish', 'block');
    // Unblock immediately: this is the uninterrupted path through the same wrapper.
    writeFileSync(join(f.helperDir, 'go'), '');
    await expect(write(f.workspace)).resolves.toMatchObject({ content: [{ text: 'Wrote sub/note.txt' }] });
    expect(readFileSync(join(f.parent, 'note.txt'), 'utf8')).toBe('approved bytes');
    expect(lstatSync(join(f.parent, 'note.txt')).nlink).toBe(1);
    if (original !== null) expect(statSync(join(f.parent, 'note.txt')).mode & 0o777).toBe(0o640);
    expect(leftovers(f.parent)).toEqual([]);
  });

  it.each([null, 'original'])('window 1: parent moved outside at publication is rolled back (target %s)', async original => {
    const f = fixture(original, 'publish', 'move-parent-outside');
    await expect(write(f.workspace)).rejects.toThrow('Approved file commit refused');
    expect(fired(f.helperDir)).toBe(true);
    if (original === null) expect(existsSync(join(f.outside, 'note.txt'))).toBe(false);
    else expect(readFileSync(join(f.outside, 'note.txt'), 'utf8')).toBe('original');
    expect(leftovers(f.outside)).toEqual([]);
  });

  it('window 1: a failed write removes its stage after the parent moves outside', async () => {
    const f = fixture(null, 'fsync', 'move-parent-outside');
    await expect(write(f.workspace)).rejects.toThrow('Approved file commit refused');
    expect(fired(f.helperDir)).toBe(true);
    expect(existsSync(join(f.outside, 'note.txt'))).toBe(false);
    expect(leftovers(f.outside)).toEqual([]);
  });

  it.each([['stage-write', null], ['publish', null], ['publish', 'original']] as const)(
    'window 2: an outside hard link to the stage made at %s keeps no approved bytes (target %s)', async (at, original) => {
      const f = fixture(original, at, 'link-stage-outside');
      await expect(write(f.workspace)).rejects.toThrow('Approved file commit refused');
      expect(fired(f.helperDir)).toBe(true);
      expect(readFileSync(f.alias, 'utf8')).toBe('');
      if (original === null) expect(existsSync(join(f.parent, 'note.txt'))).toBe(false);
      else expect(readFileSync(join(f.parent, 'note.txt'), 'utf8')).toBe('original');
      expect(leftovers(f.parent)).toEqual([]);
    });

  it.each([['replace-stage', null], ['replace-stage', 'original'], ['edit-stage', null], ['edit-stage', 'original']] as const)(
    'window 3: %s after the final check never publishes unapproved bytes (target %s)', async (action, original) => {
      const f = fixture(original, 'publish', action);
      await expect(write(f.workspace)).rejects.toThrow('Approved file commit refused');
      expect(fired(f.helperDir)).toBe(true);
      if (original === null) expect(existsSync(join(f.parent, 'note.txt'))).toBe(false);
      else expect(readFileSync(join(f.parent, 'note.txt'), 'utf8')).toBe('original');
      if (action === 'edit-stage') {
        expect(leftovers(f.parent)).toEqual([]);
        return;
      }
      // The helper never deletes what it cannot verify as its own: the concurrent
      // replacement keeps its bytes, and the renamed stage inode holds no approved bytes.
      const [replacement, held] = leftovers(f.parent).sort();
      expect(held).toBe(`${replacement}.held`);
      expect(readFileSync(join(f.parent, replacement), 'utf8')).toBe('unapproved');
      expect(readFileSync(join(f.parent, held), 'utf8')).toBe('');
    });

  it('window 4: a target replaced before publication is never overwritten', async () => {
    const f = fixture('original', 'publish', 'replace-target');
    await expect(write(f.workspace)).rejects.toThrow('Approved file commit refused');
    expect(fired(f.helperDir)).toBe(true);
    expect(readFileSync(join(f.parent, 'note.txt'), 'utf8')).toBe('concurrent');
    expect(readFileSync(join(f.parent, 'note.txt.moved'), 'utf8')).toBe('original');
    expect(leftovers(f.parent)).toEqual([]);
  });

  it('an abort while the helper runs removes the stage and publishes nothing', async () => {
    const f = fixture(null, 'fsync', 'block');
    const controller = new AbortController();
    const pending = write(f.workspace, controller.signal);
    const settled = pending.catch(error => error as Error);
    await waitFor(join(f.helperDir, 'reached'));
    controller.abort();
    await sleep(50);
    writeFileSync(join(f.helperDir, 'go'), '');
    expect(await settled).toBeInstanceOf(Error);
    expect(existsSync(join(f.parent, 'note.txt'))).toBe(false);
    expect(leftovers(f.parent)).toEqual([]);
  });

  it('a helper that stops responding is killed and its stage removed', async () => {
    const f = fixture(null, 'fsync', 'hang');
    const parentStat = lstatSync(f.parent);
    const workspaceStat = lstatSync(f.workspace);
    const parent = { path: f.parent, dev: parentStat.dev, ino: parentStat.ino, root: { dev: workspaceStat.dev, ino: workspaceStat.ino } };
    await expect(commitPiWrite(f.workspace, 'sub/note.txt', parent, null, null, 'approved bytes',
      new AbortController().signal, { timeoutMs: 300, killGraceMs: 300 })).rejects.toThrow('Approved file commit refused');
    expect(fired(f.helperDir)).toBe(true);
    expect(existsSync(join(f.parent, 'note.txt'))).toBe(false);
    expect(leftovers(f.parent)).toEqual([]);
  }, 30_000);

  it.each([null, 'original'])('a helper killed after its first publication step is recovered (target %s)', async original => {
    const f = fixture(original, 'publish', 'die', true);
    if (original === null) {
      // Killed after the exclusive link: recovery verifies and finishes the publication.
      await expect(write(f.workspace)).resolves.toMatchObject({ content: [{ text: 'Wrote sub/note.txt' }] });
      expect(readFileSync(join(f.parent, 'note.txt'), 'utf8')).toBe('approved bytes');
      expect(lstatSync(join(f.parent, 'note.txt')).nlink).toBe(1);
    } else {
      // Killed after moving the target aside: recovery restores it.
      await expect(write(f.workspace)).rejects.toThrow('Approved file commit refused');
      expect(readFileSync(join(f.parent, 'note.txt'), 'utf8')).toBe('original');
    }
    expect(fired(f.helperDir)).toBe(true);
    expect(leftovers(f.parent)).toEqual([]);
  });
});
