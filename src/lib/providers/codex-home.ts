import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { sanitizeRuntimeConfigText } from './runtime-config';
import { registeredRuntimeHome, writeOwnedRuntimeArtifact } from './owned-artifacts';

function captureAuth(file: string): { contents: string | null; modified: bigint | null } {
  if (!existsSync(file)) return { contents: null, modified: null };
  const before = statSync(file, { bigint: true });
  const raw = readFileSync(file, 'utf8');
  const after = statSync(file, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeNs !== after.mtimeNs || before.size !== after.size) {
    throw new Error('Codex source authentication changed during preparation. Retry the launch.');
  }
  const safe = sanitizeRuntimeConfigText(file, raw, 'codex');
  const contents = JSON.stringify(JSON.parse(safe), (_name, value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value);
  return { contents, modified: after.mtimeNs };
}

/** Called under the launch lock. Source credentials are borrowed as sanitized copies, never edited. */
export function isolateCodexHome(env: Record<string, string>): void {
  const source = resolve(env.CODEX_HOME || join(env.HOME || homedir(), '.codex'));
  const data = resolve(getDataDir());
  if (registeredRuntimeHome(source, 'codex')) return;
  const id = createHash('sha256').update(source).digest('hex').slice(0, 24);
  const destination = join(data, 'codex-policy-homes', id);
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const authSource = captureAuth(join(source, 'auth.json'));
  const sourceHash = `v1:${createHash('sha256').update(authSource.contents ?? 'missing').digest('hex')}`;
  const hashFile = join(destination, 'auth-source.sha256');
  if (existsSync(hashFile) && !lstatSync(hashFile).isFile()) throw new Error('Codex authentication source state is unavailable.');
  const recordedHash = existsSync(hashFile) ? readFileSync(hashFile, 'utf8') : null;
  const previousHash = recordedHash?.startsWith('v1:') ? recordedHash : null;
  for (const name of ['config.toml', 'auth.json', 'requirements.toml', 'managed_config.toml', 'installation_id', 'version.json']) {
    const from = join(source, name);
    const sourceExists = name === 'auth.json' ? authSource.contents !== null : existsSync(from);
    if (!sourceExists && !existsSync(join(destination, name))) continue;
    // Missing source auth/config must also clear any older owned copy.
    const retainedAuth = name === 'auth.json' && sourceExists && existsSync(join(destination, name))
      && (previousHash === null || previousHash === sourceHash
        || authSource.modified !== null && statSync(join(destination, name), { bigint: true }).mtimeNs >= authSource.modified);
    if (retainedAuth) continue;
    const raw = name === 'auth.json' ? authSource.contents ?? '{}'
      : sourceExists ? readFileSync(from, 'utf8') : name.endsWith('.json') ? '{}' : '';
    writeOwnedRuntimeArtifact(join(destination, name), 'codex', raw);
  }
  // An unchanged source must not overwrite OAuth refreshed by a previous child.
  if (previousHash !== sourceHash) {
    const pendingHash = `${hashFile}.${randomUUID()}.tmp`;
    writeFileSync(pendingHash, sourceHash, { mode: 0o600, flag: 'wx' });
    renameSync(pendingHash, hashFile);
  }
  // These paths contain conversation state, not credential configuration. The app
  // and the CLI keep using the same sessions and database, including resumes.
  for (const name of ['sessions', 'archived_sessions']) {
    const from = join(source, name);
    if (!existsSync(from)) continue;
    const target = join(destination, name);
    let stat;
    try { stat = lstatSync(target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!stat) symlinkSync(from, target, 'junction');
    else if (!stat.isSymbolicLink() || realpathSync(target) !== realpathSync(from)) throw new Error('Codex session overlay changed. Retry the launch.');
  }
  env.CODEX_HOME = destination;
  env.CODEX_SQLITE_HOME ||= source;
}
