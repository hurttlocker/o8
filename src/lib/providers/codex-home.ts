import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { assertCodexAccountAuth } from './runtime-config';
import { registeredRuntimeHome, setCodexAuthSource, writeOwnedRuntimeArtifact } from './owned-artifacts';
import { runtimeBillingMode } from './runtime-billing';

/** No OAuth copies or synchronization: account refresh and login share one file. */
export function prepareCodexAuth(home: string, source: string): void {
  const file = join(source, 'auth.json');
  const api = runtimeBillingMode('codex') === 'api';
  if (!api && existsSync(file)) {
    let raw: string;
    try { raw = readFileSync(file, 'utf8'); }
    catch { throw new Error('Codex account authentication is invalid. Sign in again before launching.'); }
    assertCodexAccountAuth(raw);
  }
  setCodexAuthSource(home, !api && existsSync(file) ? file : null);
  // Retire the old copy/sync bookkeeping. It never controls account selection.
  rmSync(join(home, 'auth-source.sha256'), { force: true });
}

/** Called under the launch lock. Only configuration is copied and scrubbed. */
export function isolateCodexHome(env: Record<string, string>): void {
  const source = resolve(env.CODEX_HOME || join(env.HOME || homedir(), '.codex'));
  if (registeredRuntimeHome(source, 'codex')) {
    const auth = join(source, 'auth.json');
    let linkedSource: string | undefined;
    try { if (lstatSync(auth).isSymbolicLink()) linkedSource = dirname(resolve(source, readlinkSync(auth))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    // Nested brokers retain the selected identity even when API mode has no auth link.
    const declaredSource = env.O8_CODEX_AUTH_HOME === source ? env.O8_CODEX_AUTH_SOURCE : undefined;
    const accountSource = linkedSource || declaredSource || join(env.HOME || homedir(), '.codex');
    prepareCodexAuth(source, accountSource);
    env.O8_CODEX_AUTH_SOURCE = accountSource;
    env.O8_CODEX_AUTH_HOME = source;
    return;
  }
  const id = createHash('sha256').update(source).digest('hex').slice(0, 24);
  const destination = join(resolve(getDataDir()), 'codex-policy-homes', id);
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const name of ['config.toml', 'requirements.toml', 'managed_config.toml', 'installation_id', 'version.json']) {
    const from = join(source, name);
    if (!existsSync(from) && name !== 'config.toml' && !existsSync(join(destination, name))) continue;
    const raw = existsSync(from) ? readFileSync(from, 'utf8') : name.endsWith('.json') ? '{}' : '';
    writeOwnedRuntimeArtifact(join(destination, name), 'codex', raw);
  }
  prepareCodexAuth(destination, source);
  // Conversation state remains shared for app visibility and resumes.
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
  env.O8_CODEX_AUTH_SOURCE = source;
  env.O8_CODEX_AUTH_HOME = destination;
  env.CODEX_SQLITE_HOME ||= source;
}
