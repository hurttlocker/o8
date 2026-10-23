import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { registeredRuntimeHome, writeOwnedRuntimeArtifact } from './owned-artifacts';

/** Called under the launch lock. Source credentials are borrowed as sanitized copies, never edited. */
export function isolateCodexHome(env: Record<string, string>): void {
  const source = resolve(env.CODEX_HOME || join(env.HOME || homedir(), '.codex'));
  const data = resolve(getDataDir());
  if (registeredRuntimeHome(source, 'codex')) return;
  const id = createHash('sha256').update(source).digest('hex').slice(0, 24);
  const destination = join(data, 'codex-policy-homes', id);
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const name of ['config.toml', 'auth.json', 'requirements.toml', 'managed_config.toml', 'installation_id', 'version.json']) {
    const from = join(source, name);
    if (!existsSync(from) && !existsSync(join(destination, name))) continue;
    // Missing source auth/config must also clear any older owned copy.
    const raw = existsSync(from) ? readFileSync(from, 'utf8') : name.endsWith('.json') ? '{}' : '';
    writeOwnedRuntimeArtifact(join(destination, name), 'codex', raw);
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
