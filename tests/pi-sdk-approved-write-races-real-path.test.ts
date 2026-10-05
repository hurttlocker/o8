import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { executePiTool } from '@/lib/pi/sdk/tools';
import { commitPiWrite } from '@/lib/pi/sdk/approved-write';

// Each test installs a wrapper as the packaged approved-write helper. The wrapper
// performs concurrent same-user mutations at exact filesystem calls inside the
// real helper, then the real helper continues unchanged (#3243). Steps can be
// limited to one helper process: run 1 is the commit, later runs are recovery.
const realHelper = fileURLToPath(new URL('../scripts/pi-sdk/approved-write.mjs', import.meta.url));
const WRAPPER = `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const dir = new URL('.', import.meta.url);
const plan = JSON.parse(fs.readFileSync(new URL('plan.json', dir), 'utf8'));
const runs = new URL('runs', dir);
const run = (fs.existsSync(runs) ? Number(fs.readFileSync(runs, 'utf8')) : 0) + 1;
fs.writeFileSync(runs, String(run));
const real = { renameSync: fs.renameSync, linkSync: fs.linkSync, unlinkSync: fs.unlinkSync,
  symlinkSync: fs.symlinkSync, writeSync: fs.writeSync, fsyncSync: fs.fsyncSync };
const N = plan.name;
const stage = () => fs.readdirSync('.').find(name => /^\\.o8-pi-write-[0-9a-f-]{36}$/.test(name));
const prefixed = (path, prefix) => typeof path === 'string' && path.startsWith(prefix);
const die = () => process.kill(process.pid, 'SIGKILL');
function editorSave() {
  fs.writeFileSync(N + '.editor-tmp', 'editor'); real.renameSync(N + '.editor-tmp', N);
}
function act(action) {
  if (action === 'die') die();
  else if (action === 'move-parent-outside') real.renameSync(plan.parent, plan.outside);
  else if (action === 'link-stage-outside') real.linkSync(stage(), plan.alias);
  else if (action === 'replace-stage') {
    const name = stage(); real.renameSync(name, name + '.held'); fs.writeFileSync(name, 'unapproved');
  } else if (action === 'edit-stage') fs.writeFileSync(stage(), 'unapproved edit');
  else if (action === 'replace-target') { real.renameSync(N, N + '.moved'); fs.writeFileSync(N, 'concurrent'); }
  else if (action === 'replace-target-with-symlink') { real.renameSync(N, N + '.moved'); real.symlinkSync('elsewhere', N); }
  else if (action === 'stage-symlink') {
    const name = stage(); real.renameSync(name, name + '.held'); real.symlinkSync(plan.unapproved, name);
  } else if (action === 'swap-stage-for-victim-and-die') {
    const name = stage(); real.renameSync(name, plan.alias); real.linkSync(plan.victim, name); die();
  } else if (action === 'alias-name-and-outside') { real.linkSync(stage(), N); real.linkSync(stage(), plan.alias); }
  else if (action === 'plant-backup') {
    const name = stage().replace('.o8-pi-write-', '.o8-pi-backup-');
    fs.writeFileSync(name, 'victim'); fs.writeFileSync(new URL('planted', dir), name);
  } else if (action === 'editor-save') editorSave();
  else if (action === 'editor-create') fs.writeFileSync(N, 'editor');
  else if (action === 'editor-edit-in-place') fs.writeFileSync(N, 'editor edit');
  else if (action === 'chmod-alias-die') { fs.chmodSync(N, 0o444); real.linkSync(N, plan.alias); die(); }
  else if (action === 'hardlink-replace') { real.linkSync(plan.victim, N + '.tmp-link'); real.renameSync(N + '.tmp-link', N); }
  else if (action === 'lock-dir') fs.chmodSync('.', 0o555);
  else if (action === 'block') {
    fs.writeFileSync(new URL('reached', dir), '');
    const cell = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(new URL('go', dir))) Atomics.wait(cell, 0, 0, 20);
  } else if (action === 'hang') {
    fs.writeFileSync(new URL('reached', dir), '');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
}
function hit(at, after = false) {
  plan.steps.forEach((step, index) => {
    if (step.at !== at || (step.run ?? 1) !== run || Boolean(step.after) !== after) return;
    const fired = new URL('fired-' + index, dir);
    if (fs.existsSync(fired)) return;
    fs.writeFileSync(fired, '');
    act(step.action);
  });
}
let published = false;
fs.writeSync = (...args) => { hit('stage-write'); return real.writeSync(...args); };
fs.fsyncSync = fd => { real.fsyncSync(fd); hit('fsync'); };
fs.renameSync = (from, to) => {
  const removing = from === N && (prefixed(to, '.o8-pi-q-'));
  const restoring = to === N && (prefixed(from, '.o8-pi-backup-') || prefixed(from, '.o8-pi-q-'));
  const touches = !removing && !restoring && (from === N || to === N);
  if (removing) hit('rollback-name'); else if (restoring) hit('restore-name'); else if (touches) hit('publish');
  const result = real.renameSync(from, to);
  if (touches) hit('publish', true);
  if (published && prefixed(from, '.o8-pi-write-') && prefixed(to, '.o8-pi-q-')) hit('capture-stage', true);
  return result;
};
fs.linkSync = (from, to) => {
  if (plan.noLinks) throw Object.assign(new Error('EPERM: operation not permitted, link'), { code: 'EPERM' });
  const restoring = to === N && (prefixed(from, '.o8-pi-backup-') || prefixed(from, '.o8-pi-q-'));
  const publishing = to === N && prefixed(from, '.o8-pi-write-');
  const touches = !restoring && (from === N || to === N);
  if (restoring) hit('restore-name');
  else if (touches) { hit('publish'); if (publishing) hit('link-publish'); }
  const result = real.linkSync(from, to);
  if (publishing) published = true;
  if (touches) { hit('publish', true); if (publishing) hit('link-publish', true); }
  return result;
};
fs.unlinkSync = path => {
  if (path === N) hit('rollback-name');
  const result = real.unlinkSync(path);
  if (published && path !== N) hit('after-commit-unlink', true);
  return result;
};
fs.symlinkSync = (target, path, type) => {
  if (path === N) hit('restore-name');
  return real.symlinkSync(target, path, type);
};
hit('start');
syncBuiltinESMExports();
await import(plan.helper);
`;

type At = 'start' | 'stage-write' | 'fsync' | 'publish' | 'link-publish' | 'rollback-name' | 'restore-name'
  | 'after-commit-unlink' | 'capture-stage';
interface Step { at: At; action: string; after?: boolean; run?: number }
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(original: string | null, steps: Step[], options: { noLinks?: boolean } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'o8-pi-write-race-'))); roots.push(base);
  const workspace = join(base, 'workspace');
  const parent = join(workspace, 'sub');
  mkdirSync(parent, { recursive: true });
  if (original !== null) { writeFileSync(join(parent, 'note.txt'), original); chmodSync(join(parent, 'note.txt'), 0o640); }
  const helperDir = join(base, 'helper'); mkdirSync(helperDir);
  writeFileSync(join(helperDir, 'approved-write.mjs'), WRAPPER);
  const outside = join(base, 'outside-sub');
  const alias = join(base, 'outside-alias');
  const victim = join(base, 'victim.txt'); writeFileSync(victim, 'victim');
  const unapproved = join(base, 'unapproved.txt'); writeFileSync(unapproved, 'unapproved');
  writeFileSync(join(helperDir, 'plan.json'), JSON.stringify({ helper: realHelper, steps, noLinks: options.noLinks ?? false,
    name: 'note.txt', parent, outside, alias, victim, unapproved }));
  vi.stubEnv('O8_PACKAGED_APP', '1');
  vi.stubEnv('O8_PI_SDK_DIR', helperDir);
  return { base, workspace, parent, outside, alias, victim, unapproved, helperDir, steps };
}
type Fixture = ReturnType<typeof fixture>;
function write(f: Fixture, signal = new AbortController().signal, approve = async () => true) {
  return executePiTool(f.workspace, { name: 'write_file', args: { path: 'sub/note.txt', content: 'approved bytes' } },
    approve, signal);
}
function note(f: Fixture, dir = f.parent) {
  const path = join(dir, 'note.txt');
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}
function leftovers(dir: string) {
  return readdirSync(dir).filter(name => name.startsWith('.o8-pi-'));
}
function allFired(f: Fixture) { return f.steps.every((_, index) => existsSync(join(f.helperDir, `fired-${index}`))); }
async function waitFor(file: string) {
  for (let i = 0; i < 500 && !existsSync(file); i++) await sleep(10);
  expect(existsSync(file)).toBe(true);
}
const WROTE = { content: [{ text: 'Wrote sub/note.txt' }] };

describe('approved writes under concurrent workspace mutation', () => {
  it.each([null, 'original'])('still publishes approved bytes without interference (target %s)', async original => {
    const f = fixture(original, []);
    await expect(write(f)).resolves.toMatchObject(WROTE);
    expect(note(f)).toBe('approved bytes');
    expect(lstatSync(join(f.parent, 'note.txt')).nlink).toBe(1);
    if (original !== null) expect(statSync(join(f.parent, 'note.txt')).mode & 0o777).toBe(0o640);
    expect(leftovers(f.parent)).toEqual([]);
  });

  it.each([null, 'original'])('window 1: parent moved outside at publication is rolled back (target %s)', async original => {
    const f = fixture(original, [{ at: 'publish', action: 'move-parent-outside' }]);
    await expect(write(f)).rejects.toThrow('Approved file commit refused');
    expect(allFired(f)).toBe(true);
    expect(note(f, f.outside)).toBe(original);
    expect(leftovers(f.outside)).toEqual([]);
  });

  it('window 1: a failed write removes its stage after the parent moves outside', async () => {
    const f = fixture(null, [{ at: 'fsync', action: 'move-parent-outside' }]);
    await expect(write(f)).rejects.toThrow('Approved file commit refused');
    expect(allFired(f)).toBe(true);
    expect(note(f, f.outside)).toBe(null);
    expect(leftovers(f.outside)).toEqual([]);
  });

  it.each([['stage-write', null], ['publish', null], ['publish', 'original']] as const)(
    'window 2: an outside hard link to the stage made at %s keeps no approved bytes (target %s)', async (at, original) => {
      const f = fixture(original, [{ at, action: 'link-stage-outside' }]);
      await expect(write(f)).rejects.toThrow('Approved file commit refused');
      expect(allFired(f)).toBe(true);
      expect(readFileSync(f.alias, 'utf8')).toBe('');
      expect(note(f)).toBe(original);
      expect(leftovers(f.parent)).toEqual([]);
    });

  it('window 2: aliases made at the target name before the target check keep no approved bytes', async () => {
    const f = fixture(null, [{ at: 'fsync', action: 'alias-name-and-outside' }]);
    await expect(write(f)).rejects.toThrow('Approved file commit refused');
    expect(allFired(f)).toBe(true);
    expect(readFileSync(f.alias, 'utf8')).toBe('');
    expect(note(f)).toBe('');
  });

  it.each([['replace-stage', null], ['replace-stage', 'original'], ['edit-stage', null], ['edit-stage', 'original']] as const)(
    'window 3: %s after the final check never publishes unapproved bytes (target %s)', async (action, original) => {
      const f = fixture(original, [{ at: 'publish', action }]);
      await expect(write(f)).rejects.toThrow('Approved file commit refused');
      expect(allFired(f)).toBe(true);
      expect(note(f)).toBe(original);
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

  it.each([null, 'original'])('window 3: a symlink swapped in at the stage leaves nothing unapproved published (target %s)', async original => {
    const f = fixture(original, [{ at: 'link-publish', action: 'stage-symlink' }]);
    await expect(write(f)).rejects.toThrow('Approved file commit refused');
    expect(allFired(f)).toBe(true);
    expect(note(f)).toBe(original);
    expect(lstatSync(join(f.parent, 'note.txt'), { throwIfNoEntry: false })?.isSymbolicLink() ?? false).toBe(false);
    expect(readFileSync(f.unapproved, 'utf8')).toBe('unapproved');
  });

  it('window 4: a target replaced before publication is never overwritten', async () => {
    const f = fixture('original', [{ at: 'publish', action: 'replace-target' }]);
    await expect(write(f)).rejects.toThrow('Approved file commit refused');
    expect(allFired(f)).toBe(true);
    expect(note(f)).toBe('concurrent');
    expect(readFileSync(join(f.parent, 'note.txt.moved'), 'utf8')).toBe('original');
    expect(leftovers(f.parent)).toEqual([]);
  });

  it('window 4: a file planted at the paired backup name is never overwritten', async () => {
    const f = fixture('original', [{ at: 'fsync', action: 'plant-backup' }]);
    await expect(write(f)).resolves.toMatchObject(WROTE);
    expect(allFired(f)).toBe(true);
    expect(note(f)).toBe('approved bytes');
    const planted = readFileSync(join(f.helperDir, 'planted'), 'utf8');
    expect(readFileSync(join(f.parent, planted), 'utf8')).toBe('victim');
  });

  it.each([null, 'original'])('rollback keeps an editor save made while it removes the publication (target %s)', async original => {
    const f = fixture(original, [{ at: 'publish', action: 'edit-stage' }, { at: 'rollback-name', action: 'editor-save' }]);
    const error = await write(f).catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(allFired(f)).toBe(true);
    expect(note(f)).toBe('editor');
    if (original !== null) {
      expect((error as Error).message).toMatch(/kept as \.o8-pi-backup-/);
      const kept = (error as Error).message.split('kept as ')[1];
      expect(readFileSync(join(f.parent, kept), 'utf8')).toBe('original');
    }
  });

  it('restoring a moved-aside entry never overwrites an editor save', async () => {
    const f = fixture('original', [{ at: 'publish', action: 'replace-target-with-symlink' },
      { at: 'restore-name', action: 'editor-save' }]);
    await expect(write(f)).rejects.toThrow(/kept as \.o8-pi-backup-/);
    expect(allFired(f)).toBe(true);
    expect(note(f)).toBe('editor');
    expect(readFileSync(join(f.parent, 'note.txt.moved'), 'utf8')).toBe('original');
  });

  it('an editor save between moving the target aside and publication keeps both versions', async () => {
    const f = fixture('original', [{ at: 'link-publish', action: 'editor-create' }]);
    const error = await write(f).catch((caught: Error) => caught);
    expect(allFired(f)).toBe(true);
    expect((error as Error).message).toMatch(/kept as \.o8-pi-backup-/);
    expect(note(f)).toBe('editor');
    const kept = (error as Error).message.split('kept as ')[1];
    expect(readFileSync(join(f.parent, kept), 'utf8')).toBe('original');
  });

  it('a filesystem without hard links never strands the original', async () => {
    const f = fixture('original', [], { noLinks: true });
    await expect(write(f)).rejects.toThrow('Approved file commit refused');
    expect(note(f)).toBe('original');
    expect(leftovers(f.parent)).toEqual([]);
  });

  it('an abort while the helper runs removes the stage and publishes nothing', async () => {
    const f = fixture(null, [{ at: 'fsync', action: 'block' }]);
    const controller = new AbortController();
    const settled = write(f, controller.signal).catch((error: Error) => error);
    await waitFor(join(f.helperDir, 'reached'));
    controller.abort();
    await sleep(50);
    writeFileSync(join(f.helperDir, 'go'), '');
    expect(await settled).toBeInstanceOf(Error);
    expect(note(f)).toBe(null);
    expect(leftovers(f.parent)).toEqual([]);
  });

  it('a helper that stops responding is killed and its stage removed', async () => {
    const f = fixture(null, [{ at: 'fsync', action: 'hang' }]);
    const parentStat = lstatSync(f.parent);
    const workspaceStat = lstatSync(f.workspace);
    const parent = { path: f.parent, dev: parentStat.dev, ino: parentStat.ino, root: { dev: workspaceStat.dev, ino: workspaceStat.ino } };
    await expect(commitPiWrite(f.workspace, 'sub/note.txt', parent, null, null, 'approved bytes',
      new AbortController().signal, { timeoutMs: 300, killGraceMs: 300 })).rejects.toThrow('Approved file commit refused');
    expect(allFired(f)).toBe(true);
    expect(note(f)).toBe(null);
    expect(leftovers(f.parent)).toEqual([]);
  }, 30_000);

  it.each([null, 'original'])('a helper killed after its first publication step is recovered (target %s)', async original => {
    const f = fixture(original, [{ at: 'publish', after: true, action: 'die' }]);
    if (original === null) {
      // Killed after the exclusive link: recovery verifies and finishes the publication.
      await expect(write(f)).resolves.toMatchObject(WROTE);
      expect(note(f)).toBe('approved bytes');
      expect(lstatSync(join(f.parent, 'note.txt')).nlink).toBe(1);
    } else {
      // Killed after moving the target aside: recovery restores it.
      await expect(write(f)).rejects.toThrow('Approved file commit refused');
      expect(note(f)).toBe('original');
    }
    expect(allFired(f)).toBe(true);
    expect(leftovers(f.parent)).toEqual([]);
  });

  it.each([null, 'original'])('a helper killed after removing its stage still reports the finished write (target %s)', async original => {
    const f = fixture(original, [{ at: 'after-commit-unlink', after: true, action: 'die' }]);
    await expect(write(f)).resolves.toMatchObject(WROTE);
    expect(allFired(f)).toBe(true);
    expect(note(f)).toBe('approved bytes');
    expect(lstatSync(join(f.parent, 'note.txt')).nlink).toBe(1);
    expect(leftovers(f.parent)).toEqual([]);
  });

  it('a target made read-only during approval is still finished after a kill', async () => {
    const f = fixture('original', [{ at: 'link-publish', after: true, action: 'die' }]);
    const approve = async () => { chmodSync(join(f.parent, 'note.txt'), 0o444); return true; };
    await expect(write(f, new AbortController().signal, approve)).resolves.toMatchObject(WROTE);
    expect(allFired(f)).toBe(true);
    expect(note(f)).toBe('approved bytes');
    expect(statSync(join(f.parent, 'note.txt')).mode & 0o777).toBe(0o444);
    expect(leftovers(f.parent)).toEqual([]);
  });

  it('a target made read-only during approval does not stop recovery from wiping an aliased stage', async () => {
    const f = fixture('original', [{ at: 'link-publish', action: 'link-stage-outside' },
      { at: 'link-publish', after: true, action: 'die' }]);
    const approve = async () => { chmodSync(join(f.parent, 'note.txt'), 0o444); return true; };
    await expect(write(f, new AbortController().signal, approve)).rejects.toThrow('Approved file commit refused');
    expect(allFired(f)).toBe(true);
    expect(readFileSync(f.alias, 'utf8')).toBe('');
    expect(note(f)).toBe('original');
    expect(leftovers(f.parent)).toEqual([]);
  });

  it('recovery never truncates a file swapped in at the stage name', async () => {
    const f = fixture(null, [{ at: 'fsync', action: 'swap-stage-for-victim-and-die' }]);
    await expect(write(f)).rejects.toThrow('Approved file commit refused');
    expect(allFired(f)).toBe(true);
    expect(readFileSync(f.victim, 'utf8')).toBe('victim');
    expect(note(f)).toBe(null);
  });

  it('a recovery run that dies is retried until the stage is removed', async () => {
    const f = fixture(null, [{ at: 'fsync', action: 'die' }, { run: 2, at: 'start', action: 'die' }]);
    await expect(write(f)).rejects.toThrow('Approved file commit refused');
    expect(allFired(f)).toBe(true);
    expect(readFileSync(join(f.helperDir, 'runs'), 'utf8')).toBe('3');
    expect(note(f)).toBe(null);
    expect(leftovers(f.parent)).toEqual([]);
  });

  it('an edit made after a finished write survives recovery', async () => {
    const f = fixture(null, [{ at: 'after-commit-unlink', after: true, action: 'die' },
      { run: 2, at: 'start', action: 'editor-edit-in-place' }]);
    await expect(write(f)).resolves.toMatchObject(WROTE);
    expect(allFired(f)).toBe(true);
    expect(note(f)).toBe('editor edit');
    expect(leftovers(f.parent)).toEqual([]);
  });

  it('a kill while cleanup holds the stage under a captured name still finishes the write', async () => {
    const f = fixture('original', [{ at: 'capture-stage', after: true, action: 'die' }]);
    await expect(write(f)).resolves.toMatchObject(WROTE);
    expect(allFired(f)).toBe(true);
    expect(note(f)).toBe('approved bytes');
    expect(lstatSync(join(f.parent, 'note.txt')).nlink).toBe(1);
    expect(leftovers(f.parent)).toEqual([]);
  });

  it('recovery wipes a publication made read-only and hard-linked outside after a kill', async () => {
    const f = fixture('original', [{ at: 'link-publish', after: true, action: 'chmod-alias-die' }]);
    await expect(write(f)).rejects.toThrow('Approved file commit refused');
    expect(allFired(f)).toBe(true);
    expect(readFileSync(f.alias, 'utf8')).toBe('');
    expect(note(f)).toBe('original');
    expect(leftovers(f.parent)).toEqual([]);
  });

  it('rollback keeps a replacement that is a hard link to another file', async () => {
    const f = fixture(null, [{ at: 'publish', action: 'edit-stage' }, { at: 'rollback-name', action: 'hardlink-replace' }]);
    await expect(write(f)).rejects.toThrow('Approved file commit refused');
    expect(allFired(f)).toBe(true);
    expect(note(f)).toBe('victim');
    expect(lstatSync(join(f.parent, 'note.txt')).ino).toBe(lstatSync(f.victim).ino);
  });

  it.skipIf(process.getuid?.() === 0)('a restore blocked by permissions still reports where the original is kept', async () => {
    const f = fixture('original', [{ at: 'link-publish', action: 'lock-dir' }]);
    try {
      const error = await write(f).catch((caught: Error) => caught);
      expect(allFired(f)).toBe(true);
      expect((error as Error).message).toMatch(/kept as \.o8-pi-backup-/);
      const kept = (error as Error).message.split('kept as ')[1];
      expect(readFileSync(join(f.parent, kept), 'utf8')).toBe('original');
    } finally { chmodSync(f.parent, 0o755); }
  });
});
