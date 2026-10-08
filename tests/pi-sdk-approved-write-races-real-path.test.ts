import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { executePiTool } from '@/lib/pi/sdk/tools';
import { commitPiWrite } from '@/lib/pi/sdk/approved-write';
import { buildPiWriteHelper } from './helpers/pi-write-helper';

// Each test copies the test build of the native helper (#3289) into its own
// directory next to a hook. The helper runs the hook at named points and waits
// for it, so the hook performs concurrent same-user mutations at exact steps of
// the real helper. Runs are numbered by helper process: run 1 is the commit,
// later runs are recovery.
const HOOK = `import fs from 'node:fs';
import { join } from 'node:path';
const dir = new URL('.', import.meta.url);
const plan = JSON.parse(fs.readFileSync(new URL('plan.json', dir), 'utf8'));
const [at, pid] = process.argv.slice(2);
const pidsFile = new URL('pids', dir);
const pids = fs.existsSync(pidsFile) ? fs.readFileSync(pidsFile, 'utf8').split('\\n').filter(Boolean) : [];
if (!pids.includes(pid)) {
  pids.push(pid);
  fs.writeFileSync(pidsFile, pids.join('\\n'));
  fs.writeFileSync(new URL('runs', dir), String(pids.length));
}
const run = pids.indexOf(pid) + 1;
const P = plan.parent;
const N = join(P, plan.name);
const stage = () => join(P, fs.readdirSync(P).find(name => /^\\.o8-pi-write-[0-9a-f-]{36}$/.test(name)));
const die = () => process.kill(Number(pid), 'SIGKILL');
const alive = () => { try { process.kill(Number(pid), 0); return true; } catch { return false; } };
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const read = path => fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : null;
function act(action) {
  if (action === 'die') die();
  else if (action === 'move-parent-outside') fs.renameSync(P, plan.outside);
  else if (action === 'link-stage-outside') fs.linkSync(stage(), plan.alias);
  else if (action === 'replace-stage') {
    const name = stage(); fs.renameSync(name, name + '.held'); fs.writeFileSync(name, 'unapproved');
  } else if (action === 'edit-stage') fs.writeFileSync(stage(), 'unapproved edit');
  else if (action === 'replace-target') { fs.renameSync(N, N + '.moved'); fs.writeFileSync(N, 'concurrent'); }
  else if (action === 'replace-target-with-symlink') { fs.renameSync(N, N + '.moved'); fs.symlinkSync('elsewhere', N); }
  else if (action === 'stage-symlink') {
    const name = stage(); fs.renameSync(name, name + '.held'); fs.symlinkSync(plan.unapproved, name);
  } else if (action === 'swap-stage-for-victim-and-die') {
    const name = stage(); fs.renameSync(name, plan.alias); fs.linkSync(plan.victim, name); die();
  } else if (action === 'alias-name-and-outside') { const name = stage(); fs.linkSync(name, N); fs.linkSync(name, plan.alias); }
  else if (action === 'editor-save') { fs.writeFileSync(N + '.editor-tmp', 'editor'); fs.renameSync(N + '.editor-tmp', N); }
  else if (action === 'editor-edit-in-place') fs.writeFileSync(N, 'editor edit');
  else if (action === 'chmod-name') fs.chmodSync(N, 0o600);
  else if (action === 'chmod-alias-die') { fs.chmodSync(N, 0o444); fs.linkSync(N, plan.alias); die(); }
  else if (action === 'lock-alias-die') { fs.linkSync(N, plan.alias); fs.chmodSync(N, 0o000); die(); }
  else if (action === 'hardlink-replace') { fs.linkSync(plan.victim, N + '.tmp-link'); fs.renameSync(N + '.tmp-link', N); }
  else if (action === 'lock-dir') fs.chmodSync(P, 0o555);
  else if (action === 'remove-helper-die') { fs.unlinkSync(plan.helper); die(); }
  else if (action === 'alias-save-remove-helper-die') {
    fs.linkSync(N, plan.alias);
    fs.writeFileSync(N + '.editor-tmp', 'editor'); fs.renameSync(N + '.editor-tmp', N);
    fs.unlinkSync(plan.helper); die();
  } else if (action === 'tool-create') fs.writeFileSync(N, 'tool', { flag: 'wx' });
  else if (action === 'probe') {
    fs.appendFileSync(new URL('probe', dir), JSON.stringify({ at, name: read(N), stage: read(stage()) }) + '\\n');
  } else if (action === 'block') {
    fs.writeFileSync(new URL('reached', dir), '');
    while (!fs.existsSync(new URL('go', dir))) pause(20);
  } else if (action === 'hang') {
    fs.writeFileSync(new URL('reached', dir), '');
    while (alive()) pause(20);
  }
}
plan.steps.forEach((step, index) => {
  if (step.at !== at || (step.run ?? 1) !== run) return;
  const fired = new URL('fired-' + index, dir);
  if (fs.existsSync(fired)) return;
  fs.writeFileSync(fired, '');
  act(step.action);
});
`;

type At = 'start' | 'staged' | 'synced' | 'before-publish' | 'after-publish' | 'committed' | 'captured'
  | 'before-rollback' | 'before-restore' | 'capturing' | 'finished';
interface Step { at: At; action: string; run?: number }
let hooked: string;
beforeAll(() => { hooked = buildPiWriteHelper({ hooks: true }); }, 600_000);
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(original: string | null, steps: Step[]) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'o8-pi-write-race-'))); roots.push(base);
  const workspace = join(base, 'workspace');
  const parent = join(workspace, 'sub');
  mkdirSync(parent, { recursive: true });
  if (original !== null) { writeFileSync(join(parent, 'note.txt'), original); chmodSync(join(parent, 'note.txt'), 0o640); }
  const helperDir = join(base, 'helper'); mkdirSync(helperDir);
  const helper = join(helperDir, 'o8-pi-write');
  copyFileSync(hooked, helper); chmodSync(helper, 0o755);
  writeFileSync(join(helperDir, 'hook.mjs'), HOOK);
  writeFileSync(join(helperDir, 'hook'), `#!/bin/sh\nexec '${process.execPath}' '${join(helperDir, 'hook.mjs')}' "$@"\n`, { mode: 0o755 });
  const outside = join(base, 'outside-sub');
  const alias = join(base, 'outside-alias');
  const victim = join(base, 'victim.txt'); writeFileSync(victim, 'victim');
  const unapproved = join(base, 'unapproved.txt'); writeFileSync(unapproved, 'unapproved');
  writeFileSync(join(helperDir, 'plan.json'), JSON.stringify({ steps, name: 'note.txt', parent, outside, alias, victim, unapproved, helper }));
  vi.stubEnv('O8_PI_WRITE_BIN', helper);
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
function runs(f: Fixture) { return readFileSync(join(f.helperDir, 'runs'), 'utf8'); }
function kept(error: unknown) {
  expect((error as Error).message).toMatch(/kept as \.o8-pi-(write|q)-[0-9a-f-]{36}$/);
  return (error as Error).message.split('kept as ')[1];
}
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

  it('a replacement exchanges the names in one step, so the name always holds a file', async () => {
    const f = fixture('original', [{ at: 'before-publish', action: 'probe' }, { at: 'after-publish', action: 'probe' }]);
    await expect(write(f)).resolves.toMatchObject(WROTE);
    const probes = readFileSync(join(f.helperDir, 'probe'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(probes).toEqual([
      { at: 'before-publish', name: 'original', stage: 'approved bytes' },
      { at: 'after-publish', name: 'approved bytes', stage: 'original' },
    ]);
    expect(leftovers(f.parent)).toEqual([]);
  });

  it.each([null, 'original'])('window 1: parent moved outside at publication is rolled back (target %s)', async original => {
    const f = fixture(original, [{ at: 'before-publish', action: 'move-parent-outside' }]);
    await expect(write(f)).rejects.toThrow('Approved file commit refused');
    expect(allFired(f)).toBe(true);
    expect(note(f, f.outside)).toBe(original);
    expect(leftovers(f.outside)).toEqual([]);
  });

  it('window 1: a failed write removes its stage after the parent moves outside', async () => {
    const f = fixture(null, [{ at: 'synced', action: 'move-parent-outside' }]);
    await expect(write(f)).rejects.toThrow('Approved file commit refused');
    expect(allFired(f)).toBe(true);
    expect(note(f, f.outside)).toBe(null);
    expect(leftovers(f.outside)).toEqual([]);
  });

  it.each([null, 'original'])('recovery reaches a parent moved outside after a kill and rolls back there (target %s)', async original => {
    const f = fixture(original, [{ at: 'after-publish', action: 'die' }, { run: 2, at: 'start', action: 'move-parent-outside' }]);
    await expect(write(f)).rejects.toThrow('Approved file commit refused');
    expect(allFired(f)).toBe(true);
    expect(note(f, f.outside)).toBe(original);
    expect(leftovers(f.outside)).toEqual([]);
  });

  it.each([['staged', null], ['before-publish', null], ['before-publish', 'original']] as const)(
    'window 2: an outside hard link to the stage made at %s keeps no approved bytes (target %s)', async (at, original) => {
      const f = fixture(original, [{ at, action: 'link-stage-outside' }]);
      await expect(write(f)).rejects.toThrow('Approved file commit refused');
      expect(allFired(f)).toBe(true);
      expect(readFileSync(f.alias, 'utf8')).toBe('');
      expect(note(f)).toBe(original);
      expect(leftovers(f.parent)).toEqual([]);
    });

  it('window 2: aliases made at the target name before the target check keep no approved bytes', async () => {
    const f = fixture(null, [{ at: 'synced', action: 'alias-name-and-outside' }]);
    await expect(write(f)).rejects.toThrow('Approved file commit refused');
    expect(allFired(f)).toBe(true);
    expect(readFileSync(f.alias, 'utf8')).toBe('');
    expect(note(f)).toBe('');
  });

  it.each([null, 'original'])('window 3: an edit to the stage after the final check is refused and wiped (target %s)', async original => {
    const f = fixture(original, [{ at: 'before-publish', action: 'edit-stage' }]);
    await expect(write(f)).rejects.toThrow('Approved file commit refused');
    expect(allFired(f)).toBe(true);
    expect(note(f)).toBe(original);
    expect(leftovers(f.parent)).toEqual([]);
  });

  // A process that renames the hidden stage away and puts its own entry there
  // in the microseconds before publication gets that entry published. It could
  // write the name directly. The helper never claims the write, never moves the
  // entry again (it cannot tell it from an editor save), wipes the approved bytes
  // through the descriptor it holds, and reports where the original went.
  it.each([['replace-stage', null], ['replace-stage', 'original'], ['stage-symlink', null], ['stage-symlink', 'original']] as const)(
    'window 3: an entry swapped in at the hidden stage (%s) is refused, wiped and reported (target %s)', async (action, original) => {
      const f = fixture(original, [{ at: 'before-publish', action }]);
      const error = await write(f).catch((caught: Error) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(allFired(f)).toBe(true);
      const held = leftovers(f.parent).find(name => name.endsWith('.held'))!;
      expect(readFileSync(join(f.parent, held), 'utf8')).toBe('');
      if (action === 'replace-stage') expect(note(f)).toBe('unapproved');
      else expect(lstatSync(join(f.parent, 'note.txt')).isSymbolicLink()).toBe(true);
      expect(readFileSync(f.unapproved, 'utf8')).toBe('unapproved');
      if (original !== null) expect(readFileSync(join(f.parent, kept(error)), 'utf8')).toBe('original');
      else expect((error as Error).message).toBe('Approved file commit refused');
    });

  it('window 3: after a kill, recovery still wipes a stage renamed away', async () => {
    const f = fixture(null, [{ at: 'before-publish', action: 'replace-stage' }, { at: 'after-publish', action: 'die' }]);
    await expect(write(f)).rejects.toThrow('Approved file commit refused');
    expect(allFired(f)).toBe(true);
    expect(runs(f)).toBe('2');
    const held = leftovers(f.parent).find(name => name.endsWith('.held'))!;
    expect(readFileSync(join(f.parent, held), 'utf8')).toBe('');
  });

  it('window 4: a target replaced before publication is never overwritten', async () => {
    const f = fixture('original', [{ at: 'before-publish', action: 'replace-target' }]);
    await expect(write(f)).rejects.toThrow('Approved file commit refused');
    expect(allFired(f)).toBe(true);
    expect(note(f)).toBe('concurrent');
    expect(readFileSync(join(f.parent, 'note.txt.moved'), 'utf8')).toBe('original');
    expect(leftovers(f.parent)).toEqual([]);
  });

  it('window 4: an edit to the target just before publication stays at the name', async () => {
    const f = fixture('original', [{ at: 'before-publish', action: 'editor-edit-in-place' }]);
    await expect(write(f)).rejects.toThrow('Approved file commit refused');
    expect(allFired(f)).toBe(true);
    expect(note(f)).toBe('editor edit');
    expect(leftovers(f.parent)).toEqual([]);
  });

  it.each([null, 'original'])('rollback keeps an editor save made while it removes the publication (target %s)', async original => {
    const f = fixture(original, [{ at: 'before-publish', action: 'edit-stage' }, { at: 'before-rollback', action: 'editor-save' }]);
    const error = await write(f).catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(allFired(f)).toBe(true);
    expect(note(f)).toBe('editor');
    if (original !== null) expect(readFileSync(join(f.parent, kept(error)), 'utf8')).toBe('original');
  });

  it('restoring the swapped-out entry never overwrites an editor save', async () => {
    const f = fixture('original', [{ at: 'before-publish', action: 'replace-target-with-symlink' },
      { at: 'before-restore', action: 'editor-save' }]);
    const error = await write(f).catch((caught: Error) => caught);
    expect(allFired(f)).toBe(true);
    expect(note(f)).toBe('editor');
    expect(readFileSync(join(f.parent, 'note.txt.moved'), 'utf8')).toBe('original');
    // The symlink that held the name when it was exchanged is reported where it was kept.
    expect(lstatSync(join(f.parent, kept(error))).isSymbolicLink()).toBe(true);
  });

  it('an abort while the helper runs removes the stage and publishes nothing', async () => {
    const f = fixture(null, [{ at: 'synced', action: 'block' }]);
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
    const f = fixture(null, [{ at: 'synced', action: 'hang' }]);
    const parentStat = lstatSync(f.parent);
    const workspaceStat = lstatSync(f.workspace);
    const parent = { path: f.parent, dev: parentStat.dev, ino: parentStat.ino, root: { dev: workspaceStat.dev, ino: workspaceStat.ino } };
    await expect(commitPiWrite(f.workspace, 'sub/note.txt', parent, null, null, 'approved bytes',
      new AbortController().signal, { timeoutMs: 2_000, killGraceMs: 500 })).rejects.toThrow('Approved file commit refused');
    expect(allFired(f)).toBe(true);
    expect(note(f)).toBe(null);
    expect(leftovers(f.parent)).toEqual([]);
  }, 30_000);

  it.each([null, 'original'])('a helper killed right after publication is recovered and finished (target %s)', async original => {
    const f = fixture(original, [{ at: 'after-publish', action: 'die' }]);
    await expect(write(f)).resolves.toMatchObject(WROTE);
    expect(allFired(f)).toBe(true);
    expect(note(f)).toBe('approved bytes');
    expect(lstatSync(join(f.parent, 'note.txt')).nlink).toBe(1);
    if (original !== null) expect(statSync(join(f.parent, 'note.txt')).mode & 0o777).toBe(0o640);
    expect(leftovers(f.parent)).toEqual([]);
  });

  it.each([null, 'original'])('a helper killed after its commit point still reports the finished write (target %s)', async original => {
    const f = fixture(original, [{ at: 'committed', action: 'die' }]);
    await expect(write(f)).resolves.toMatchObject(WROTE);
    expect(allFired(f)).toBe(true);
    expect(note(f)).toBe('approved bytes');
    expect(lstatSync(join(f.parent, 'note.txt')).nlink).toBe(1);
    expect(leftovers(f.parent)).toEqual([]);
  });

  it('a recovery run that finishes the write reports its commit point to later runs', async () => {
    const f = fixture(null, [{ at: 'after-publish', action: 'die' }, { run: 2, at: 'committed', action: 'die' },
      { run: 3, at: 'start', action: 'editor-edit-in-place' }]);
    await expect(write(f)).resolves.toMatchObject(WROTE);
    expect(allFired(f)).toBe(true);
    expect(runs(f)).toBe('3');
    expect(note(f)).toBe('editor edit');
    expect(leftovers(f.parent)).toEqual([]);
  });

  it('committed recovery never reapplies the target mode over a later change', async () => {
    const f = fixture('original', [{ at: 'committed', action: 'die' }, { run: 2, at: 'start', action: 'chmod-name' }]);
    await expect(write(f)).resolves.toMatchObject(WROTE);
    expect(allFired(f)).toBe(true);
    expect(note(f)).toBe('approved bytes');
    expect(statSync(join(f.parent, 'note.txt')).mode & 0o777).toBe(0o600);
    expect(leftovers(f.parent)).toEqual([]);
  });

  it('a target made read-only during approval is still finished after a kill', async () => {
    const f = fixture('original', [{ at: 'after-publish', action: 'die' }]);
    const approve = async () => { chmodSync(join(f.parent, 'note.txt'), 0o444); return true; };
    await expect(write(f, new AbortController().signal, approve)).resolves.toMatchObject(WROTE);
    expect(allFired(f)).toBe(true);
    expect(note(f)).toBe('approved bytes');
    expect(statSync(join(f.parent, 'note.txt')).mode & 0o777).toBe(0o444);
    expect(leftovers(f.parent)).toEqual([]);
  });

  it('a target made read-only during approval does not stop recovery from wiping an aliased stage', async () => {
    const f = fixture('original', [{ at: 'before-publish', action: 'link-stage-outside' },
      { at: 'after-publish', action: 'die' }]);
    const approve = async () => { chmodSync(join(f.parent, 'note.txt'), 0o444); return true; };
    await expect(write(f, new AbortController().signal, approve)).rejects.toThrow('Approved file commit refused');
    expect(allFired(f)).toBe(true);
    expect(readFileSync(f.alias, 'utf8')).toBe('');
    expect(note(f)).toBe('original');
    expect(leftovers(f.parent)).toEqual([]);
  });

  it('recovery never truncates a file swapped in at the stage name, and wipes the stage moved outside', async () => {
    const f = fixture(null, [{ at: 'synced', action: 'swap-stage-for-victim-and-die' }]);
    await expect(write(f)).rejects.toThrow('Approved file commit refused');
    expect(allFired(f)).toBe(true);
    expect(readFileSync(f.victim, 'utf8')).toBe('victim');
    expect(readFileSync(f.alias, 'utf8')).toBe('');
    expect(note(f)).toBe(null);
  });

  it('a write whose recovery cannot start still wipes its stage and says where the original may be', async () => {
    const f = fixture('original', [{ at: 'after-publish', action: 'alias-save-remove-helper-die' }]);
    const error = await write(f).catch((caught: Error) => caught);
    expect(allFired(f)).toBe(true);
    expect(readFileSync(f.alias, 'utf8')).toBe('');
    expect(note(f)).toBe('editor');
    expect((error as Error).message).toMatch(/may be kept as|kept as/);
    expect(readFileSync(join(f.parent, kept(error)), 'utf8')).toBe('original');
  });

  it('a committed write whose recovery cannot start is still reported written', async () => {
    const f = fixture('original', [{ at: 'committed', action: 'remove-helper-die' }]);
    await expect(write(f)).resolves.toMatchObject(WROTE);
    expect(allFired(f)).toBe(true);
    expect(note(f)).toBe('approved bytes');
    // Cleanup did not run, so the replaced file is still under the stage name.
    expect(leftovers(f.parent).map(name => readFileSync(join(f.parent, name), 'utf8'))).toEqual(['original']);
  });

  it('a helper that cannot start leaves no stage behind', async () => {
    const f = fixture('original', []);
    chmodSync(join(f.helperDir, 'o8-pi-write'), 0o644);
    await expect(write(f)).rejects.toThrow('Approved file commit refused');
    expect(note(f)).toBe('original');
    expect(leftovers(f.parent)).toEqual([]);
  });

  it('every entry rollback could not put back is reported', async () => {
    const f = fixture('original', [{ at: 'before-publish', action: 'edit-stage' }, { at: 'capturing', action: 'editor-save' },
      { at: 'captured', action: 'tool-create' }]);
    const error = await write(f).catch((caught: Error) => caught);
    expect(allFired(f)).toBe(true);
    expect(note(f)).toBe('tool');
    const names = (error as Error).message.split('moved entries were kept as ')[1].split(', ');
    expect(names.map(name => readFileSync(join(f.parent, name), 'utf8'))).toEqual(['original', 'editor']);
  });

  it('a kept receipt follows an entry a later killed run moved', async () => {
    const f = fixture('original', [{ at: 'before-publish', action: 'edit-stage' }, { at: 'before-rollback', action: 'editor-save' },
      { at: 'finished', action: 'die' }, { run: 2, at: 'captured', action: 'remove-helper-die' }]);
    const error = await write(f).catch((caught: Error) => caught);
    expect(allFired(f)).toBe(true);
    const name = kept(error);
    expect(name).toMatch(/^\.o8-pi-q-/);
    expect(readFileSync(join(f.parent, name), 'utf8')).toBe('original');
  });

  it('a refusal names the capture that holds the original when every recovery run is killed', async () => {
    const f = fixture('original', [{ at: 'after-publish', action: 'editor-save' }, { at: 'captured', action: 'die' },
      { run: 2, at: 'start', action: 'die' }, { run: 3, at: 'start', action: 'die' }, { run: 4, at: 'start', action: 'die' }]);
    const error = await write(f).catch((caught: Error) => caught);
    expect(allFired(f)).toBe(true);
    expect(runs(f)).toBe('4');
    expect(note(f)).toBe('editor');
    const name = kept(error);
    expect(name).toMatch(/^\.o8-pi-q-/);
    expect(readFileSync(join(f.parent, name), 'utf8')).toBe('original');
  });

  it('a refusal lists where entries may be when the folder moved and no run could report', async () => {
    const f = fixture('original', [{ at: 'after-publish', action: 'editor-save' }, { at: 'captured', action: 'die' },
      { run: 2, at: 'start', action: 'move-parent-outside' }, { run: 2, at: 'start', action: 'die' },
      { run: 3, at: 'start', action: 'die' }, { run: 4, at: 'start', action: 'die' }]);
    const error = await write(f).catch((caught: Error) => caught);
    expect(allFired(f)).toBe(true);
    const places = (error as Error).message.split('may be kept as ')[1].split(', ');
    expect(places.filter(name => existsSync(join(f.outside, name))).map(name => readFileSync(join(f.outside, name), 'utf8')))
      .toEqual(['original']);
    expect(note(f, f.outside)).toBe('editor');
  });

  it('recovery finishes a rollback that was killed after taking the publication off the name', async () => {
    const f = fixture('original', [{ at: 'before-publish', action: 'editor-save' }, { at: 'after-publish', action: 'die' },
      { run: 2, at: 'captured', action: 'die' }]);
    await expect(write(f)).rejects.toThrow(/^Approved file commit refused$/);
    expect(allFired(f)).toBe(true);
    expect(runs(f)).toBe('3');
    expect(note(f)).toBe('editor');
    expect(leftovers(f.parent)).toEqual([]);
  });

  it('a kept receipt survives a recovery run that cannot start', async () => {
    const f = fixture('original', [{ at: 'before-publish', action: 'edit-stage' }, { at: 'before-rollback', action: 'editor-save' },
      { at: 'finished', action: 'remove-helper-die' }]);
    const error = await write(f).catch((caught: Error) => caught);
    expect(allFired(f)).toBe(true);
    expect(note(f)).toBe('editor');
    expect(readFileSync(join(f.parent, kept(error)), 'utf8')).toBe('original');
  });

  it('a recovery run that dies is retried until the stage is removed', async () => {
    const f = fixture(null, [{ at: 'synced', action: 'die' }, { run: 2, at: 'start', action: 'die' }]);
    await expect(write(f)).rejects.toThrow('Approved file commit refused');
    expect(allFired(f)).toBe(true);
    expect(runs(f)).toBe('3');
    expect(note(f)).toBe(null);
    expect(leftovers(f.parent)).toEqual([]);
  });

  it('an edit made after a finished write survives recovery', async () => {
    const f = fixture(null, [{ at: 'committed', action: 'die' }, { run: 2, at: 'start', action: 'editor-edit-in-place' }]);
    await expect(write(f)).resolves.toMatchObject(WROTE);
    expect(allFired(f)).toBe(true);
    expect(note(f)).toBe('editor edit');
    expect(leftovers(f.parent)).toEqual([]);
  });

  it('a kill while cleanup holds the replaced target under a captured name still finishes the write', async () => {
    const f = fixture('original', [{ at: 'captured', action: 'die' }]);
    await expect(write(f)).resolves.toMatchObject(WROTE);
    expect(allFired(f)).toBe(true);
    expect(note(f)).toBe('approved bytes');
    expect(lstatSync(join(f.parent, 'note.txt')).nlink).toBe(1);
    expect(leftovers(f.parent)).toEqual([]);
  });

  it('recovery wipes a publication made read-only and hard-linked outside after a kill', async () => {
    const f = fixture('original', [{ at: 'after-publish', action: 'chmod-alias-die' }]);
    await expect(write(f)).rejects.toThrow('Approved file commit refused');
    expect(allFired(f)).toBe(true);
    expect(readFileSync(f.alias, 'utf8')).toBe('');
    expect(note(f)).toBe('original');
    expect(leftovers(f.parent)).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)('recovery wipes a publication made unreadable and hard-linked outside after a kill', async () => {
    const f = fixture('original', [{ at: 'after-publish', action: 'lock-alias-die' }]);
    await expect(write(f)).rejects.toThrow('Approved file commit refused');
    expect(allFired(f)).toBe(true);
    expect(statSync(f.alias).size).toBe(0);
    expect(note(f)).toBe('original');
    expect(leftovers(f.parent)).toEqual([]);
  });

  it('rollback keeps a replacement that is a hard link to another file', async () => {
    const f = fixture(null, [{ at: 'before-publish', action: 'edit-stage' }, { at: 'before-rollback', action: 'hardlink-replace' }]);
    await expect(write(f)).rejects.toThrow('Approved file commit refused');
    expect(allFired(f)).toBe(true);
    expect(note(f)).toBe('victim');
    expect(lstatSync(join(f.parent, 'note.txt')).ino).toBe(lstatSync(f.victim).ino);
  });

  it.skipIf(process.getuid?.() === 0)('a rollback blocked by permissions still reports where the original is kept', async () => {
    const f = fixture('original', [{ at: 'before-publish', action: 'edit-stage' }, { at: 'before-rollback', action: 'lock-dir' }]);
    try {
      const error = await write(f).catch((caught: Error) => caught);
      expect(allFired(f)).toBe(true);
      expect(readFileSync(join(f.parent, kept(error)), 'utf8')).toBe('original');
      // The refused publication could not be moved, so its inode was wiped in place.
      expect(note(f)).toBe('');
    } finally { chmodSync(f.parent, 0o755); }
  });

  it.skipIf(process.getuid?.() === 0)('a recovery blocked by permissions still reports where the original is kept', async () => {
    const f = fixture('original', [{ at: 'before-publish', action: 'edit-stage' }, { at: 'after-publish', action: 'die' },
      { run: 2, at: 'start', action: 'lock-dir' }]);
    try {
      const error = await write(f).catch((caught: Error) => caught);
      expect(allFired(f)).toBe(true);
      expect(readFileSync(join(f.parent, kept(error)), 'utf8')).toBe('original');
      expect(note(f)).toBe('');
    } finally { chmodSync(f.parent, 0o755); }
  });
});
