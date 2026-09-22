import Database from 'better-sqlite3';
import { constants, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { getDataDir } from '@/lib/data-dir-migration';
import { findRepoByLocalPath } from '@/lib/repos/registry';
import { MAX_PACKAGE_BYTES, packageSchema, skillMarkdown, skillSchema, type DamagedPackage, type InstalledPackage, type InstructionPackage, type SkillDraft } from './packages';

export class CustomizeError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
export async function resolveScope(repo: unknown): Promise<string | null> {
  if (repo === undefined || repo === null) return null;
  if (typeof repo !== 'string' || !path.isAbsolute(repo) || repo.split(path.sep).includes('..')) throw new CustomizeError('invalid_scope', 'Choose Personal or a registered repository.');
  const registered = await findRepoByLocalPath(repo);
  if (!registered?.localPath) throw new CustomizeError('invalid_scope', 'Repository is not registered.', 403);
  return realpathSync(registered.localPath);
}

/** Reject links at every child component, including links that stay inside the boundary. */
function directory(base: string, parts: string[], create: boolean): string {
  let current = realpathSync(base);
  for (const part of parts) {
    current = path.join(current, part);
    if (create && !existsSync(current)) mkdirSync(current, { mode: 0o700 });
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new CustomizeError('unsafe_path', 'This location contains a linked or invalid folder. Choose another scope.');
  }
  return current;
}
function managedRoot(repo: string | null, create: boolean): string {
  const base = getDataDir();
  if (create && !existsSync(base)) mkdirSync(base, { recursive: true, mode: 0o700 });
  const parts = repo ? ['customizations', 'projects', createHash('sha256').update(realpathSync(repo)).digest('hex'), 'plugins'] : ['customizations', 'plugins'];
  return directory(base, parts, create);
}
function readJson(file: string): unknown {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PACKAGE_BYTES) throw new CustomizeError('invalid_installation', 'The saved package is invalid.');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return JSON.parse(readFileSync(fd, 'utf8')); } finally { closeSync(fd); }
}
function idChecked(id: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || id.length > 64) throw new CustomizeError('invalid_id', 'Invalid plugin identifier.');
  return id;
}
function packageDir(root: string, id: string, create = false) { return directory(root, [idChecked(id)], create); }
function load(root: string, id: string): InstalledPackage {
  const dir = packageDir(root, id);
  const raw = readJson(path.join(dir, 'installed.json')) as { manifest: unknown; enabled: unknown; revision: unknown };
  const manifest = packageSchema.parse(raw.manifest);
  if (manifest.id !== id || typeof raw.enabled !== 'boolean' || typeof raw.revision !== 'string' || !/^[a-f0-9]{64}$/.test(raw.revision)) throw new CustomizeError('invalid_installation', 'The saved package is invalid.');
  if (createHash('sha256').update(JSON.stringify(manifest)).digest('hex') !== raw.revision) throw new CustomizeError('invalid_installation', 'The installed manifest has changed.');
  const versionDir = directory(dir, [raw.revision], false);
  const files = manifest.skills.map((skill) => {
    const file = path.join(versionDir, `${skill.name}.md`);
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new CustomizeError('invalid_installation', 'A package file is missing or linked.');
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (readFileSync(fd, 'utf8') !== skillMarkdown(skill)) throw new CustomizeError('invalid_installation', 'Installed instructions changed after installation.');
    } finally { closeSync(fd); }
    return { name: skill.name, file };
  });
  return { manifest, enabled: raw.enabled, revision: raw.revision, files };
}
export function inspectPackages(repo: string | null): { installed: InstalledPackage[]; damaged: DamagedPackage[] } {
  let root: string;
  const result: { installed: InstalledPackage[]; damaged: DamagedPackage[] } = { installed: [], damaged: [] };
  try { root = managedRoot(repo, false); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result; throw error; }
  for (const id of readdirSync(root).filter((id) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))) {
    try { result.installed.push(load(root, id)); }
    catch { result.damaged.push({ id, message: 'This installation is damaged or has changed. Remove it and install a trusted copy.' }); }
  }
  return result;
}
export function listPackages(repo: string | null): InstalledPackage[] { return inspectPackages(repo).installed; }

function save(dir: string, value: { manifest: InstructionPackage; enabled: boolean; revision: string }) {
  const temporary = path.join(dir, `.save-${randomUUID()}`);
  try {
    writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path.join(dir, 'installed.json'));
  } finally { rmSync(temporary, { force: true }); }
}
/** SQLite owns the process lock, so an interrupted writer cannot leave a stale lock. */
function locked<T>(root: string, action: () => T): T {
  const file = path.join(root, '.mutation-lock.sqlite');
  const fd = openSync(file, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  closeSync(fd);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new CustomizeError('unsafe_path', 'The installation lock is invalid.');
  const db = new Database(file, { timeout: 0 });
  try {
    try { db.exec('BEGIN EXCLUSIVE'); } catch { throw new CustomizeError('busy', 'Another installation is in progress. Retry in a moment.', 409); }
    return action();
  } finally { if (db.inTransaction) db.exec('ROLLBACK'); db.close(); }
}
export function installPackage(repo: string | null, manifest: InstructionPackage, expectedRevision: string | null): InstalledPackage {
  manifest = packageSchema.parse(manifest);
  const root = managedRoot(repo, true);
  return locked(root, () => {
    const existing = existsSync(path.join(root, manifest.id)) ? load(root, manifest.id) : null;
    if ((existing?.revision ?? null) !== expectedRevision) throw new CustomizeError('conflict', 'This plugin changed or is already installed. Refresh and review it again.', 409);
    if (existing) {
      const before = existing.manifest.version.split('.').map(Number);
      const after = manifest.version.split('.').map(Number);
      const different = after.findIndex((value, index) => value !== before[index]);
      if (different < 0 || after[different] < before[different]) throw new CustomizeError('same_version', 'Use a newer version number when updating a plugin.', 409);
    }
    const dir = existing ? packageDir(root, manifest.id) : directory(root, [`.install-${randomUUID()}`], true);
    const revision = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
    const versionDir = path.join(dir, revision);
    const stage = path.join(dir, `.stage-${randomUUID()}`);
    try {
      mkdirSync(stage, { mode: 0o700 });
      for (const skill of manifest.skills) writeFileSync(path.join(stage, `${skill.name}.md`), skillMarkdown(skill), { flag: 'wx', mode: 0o600 });
      // An interrupted update can leave an unpublished revision. It is not the active version.
      if (existsSync(versionDir)) {
        directory(dir, [revision], false);
        rmSync(versionDir, { recursive: true });
      }
      renameSync(stage, versionDir);
      save(dir, { manifest, enabled: existing?.enabled ?? true, revision });
      if (!existing) renameSync(dir, path.join(root, manifest.id));
      return { manifest, enabled: existing?.enabled ?? true, revision, files: manifest.skills.map((skill) => ({ name: skill.name, file: path.join(root, manifest.id, revision, `${skill.name}.md`) })) };
    } catch (error) {
      if (existing) rmSync(versionDir, { recursive: true, force: true });
      if (!existing) rmSync(dir, { recursive: true, force: true });
      throw error;
    } finally { rmSync(stage, { recursive: true, force: true }); }
  });
}
export function changePackage(repo: string | null, id: string, revision: string, enabled: boolean | null) {
  const root = managedRoot(repo, false);
  return locked(root, () => {
    idChecked(id);
    const dir = packageDir(root, id);
    if (enabled === null && revision === 'damaged') {
      let valid = false;
      try { load(root, id); valid = true; } catch { /* Only an invalid managed installation can use this recovery action. */ }
      if (valid) throw new CustomizeError('conflict', 'This plugin is now valid. Refresh and review removal again.', 409);
    } else {
      const current = load(root, id);
      if (current.revision !== revision) throw new CustomizeError('conflict', 'This plugin changed. Refresh and try again.', 409);
      if (enabled !== null) {
        save(dir, { manifest: current.manifest, revision, enabled });
        return { cleanupPending: false };
      }
    }
    const trash = path.join(root, `.removed-${randomUUID()}`);
    renameSync(dir, trash);
    try { rmSync(trash, { recursive: true, force: true }); return { cleanupPending: false }; }
    catch { return { cleanupPending: true }; }
  });
}
export function createSkill(repo: string | null, draft: SkillDraft): string {
  const skill = skillSchema.parse(draft);
  const root = directory(repo ?? os.homedir(), ['.agents', 'skills'], true);
  const destination = path.join(root, skill.name);
  try { mkdirSync(destination, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new CustomizeError('duplicate', 'A skill with this name already exists here. Choose a different name.', 409);
    throw error;
  }
  try {
    const checked = directory(root, [skill.name], false);
    const file = path.join(checked, 'SKILL.md');
    writeFileSync(file, skillMarkdown(skill), { flag: 'wx', mode: 0o600 });
    return file;
  } catch (error) { rmSync(destination, { recursive: true, force: true }); throw error; }
}
