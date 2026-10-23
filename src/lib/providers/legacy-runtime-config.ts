/** Read-only refusal of old shared profiles. Migration belongs to #4340. */
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

const warned = new Set<string>();
function canonical(file: string): string {
  const absolute = resolve(file);
  try { return realpathSync(absolute); } catch {
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(canonical(parent), basename(absolute));
  }
}
const within = (root: string, file: string) => {
  const path = relative(canonical(root), canonical(file));
  return path !== '..' && !path.startsWith('../') && !isAbsolute(path);
};
const refusal = () => new Error('Existing runtime credential files were left unchanged. This launch requires the file-auth design in #4340.');
function warn(file: string): void {
  if (warned.has(file)) return;
  warned.add(file);
  console.warn(`[payer-policy] Existing runtime config left unchanged: ${JSON.stringify(file)}. See #4340.`);
}
function records(): string[] {
  const file = join(getDataDir(), 'owned-credential-artifacts.json');
  if (!existsSync(file)) return [];
  if (!lstatSync(file).isFile()) throw refusal();
  let value: unknown;
  try { value = JSON.parse(readFileSync(file, 'utf8')); } catch { throw refusal(); }
  if (!Array.isArray(value) || value.length > 100_000) throw refusal();
  return value.filter(record => record?.owner === 'o8' && record.runtime !== 'codex' && typeof record.path === 'string' && isAbsolute(record.path)
    // payer policy part b: MCP consumers retain their existing config contract.
    && !within(join(getDataDir(), 'mcp'), record.path)).map(record => record.path);
}
export function warnLegacyRuntimeConfigs(): void {
  try { for (const file of records()) if (existsSync(file)) warn(file); }
  catch { warn(join(getDataDir(), 'owned-credential-artifacts.json')); }
}
function knownOwned(file: string): boolean {
  const roots = [join(getDataDir(), 'hermes-o8'), join(homedir(), '.openclaw-o8')];
  const data = relative(canonical(getDataDir()), canonical(file));
  if (/^owned-(?!codex)[a-z0-9-]+(?:\/|$)/.test(data)) return true;
  for (const [name, value] of Object.entries(process.env)) if (/^(O8|CORTEX_IDE)_OWNED_[A-Z0-9_]+_ROOT$/.test(name) && !name.includes('CODEX') && value) roots.push(value, `${value.replace(/\/+$/, '')}-archive`);
  return roots.some(root => within(root, file));
}

/** Baseline preparation may seed a new key-free profile, never reuse an old one. */
export function assertNewRuntimeProfile(home: string): void {
  const old = records().find(file => within(home, file));
  if (old || existsSync(home)) { warn(old ?? home); throw refusal(); }
}

/** Refuse by path/provenance, not a key read that a surviving child can race. */
export function assertLegacyRuntimeConfigSelection(runtimeId: string | undefined, env: Record<string, string | undefined>, args: readonly string[]): void {
  // Codex home/auth behavior remains main's contract (#4334).
  if (runtimeId === 'codex') return;
  const selected: string[] = [];
  const selectors: Record<string, string[]> = {
    hermes: ['HERMES_HOME'], 'claude-code': ['CLAUDE_CONFIG_DIR'], gemini: ['GEMINI_CLI_HOME'],
    openclaw: ['OPENCLAW_STATE_DIR', 'OPENCLAW_CONFIG_PATH'],
  };
  const generic = !runtimeId || runtimeId === 'acp';
  const names = generic ? Object.values(selectors).flat() : selectors[runtimeId] ?? [];
  for (const name of names) if (env[name]) {
    if (!isAbsolute(env[name]!)) throw refusal();
    selected.push(env[name]!);
  }
  if (env.HOME && !isAbsolute(env.HOME)) throw refusal();
  const implicit: Record<string, string> = { hermes: '.hermes', 'claude-code': '.claude', gemini: '.gemini', openclaw: '.openclaw-o8' };
  for (const name of generic ? Object.values(implicit) : implicit[runtimeId] ? [implicit[runtimeId]] : []) selected.push(join(env.HOME || homedir(), name));
  if (runtimeId === 'openclaw' || args.some((arg, index) => arg === '--profile' && args[index + 1] === 'o8')) selected.push(join(homedir(), '.openclaw-o8'));
  for (const arg of args) if (isAbsolute(arg)) selected.push(arg);
  // An unknown transport can read implicit Hermes state too. Refuse the path
  // regardless of current contents: an older API child may rewrite it later.
  if (!runtimeId || runtimeId === 'acp' || runtimeId === 'hermes') {
    for (const home of [env.HERMES_HOME, join(env.HOME || homedir(), '.hermes')]) {
      if (home && existsSync(home)) { warn(home); throw refusal(); }
    }
  }
  for (const file of records()) {
    if (selected.some(path => within(path, file) || file === path)) { warn(file); throw refusal(); }
  }
  for (const path of selected) {
    // Concrete environment-auth runtimes keep their ordinary profile contract.
    // Known registered legacy files above still refuse admission. Broad path
    // refusal is for unknown transports and the deferred file-auth runtimes.
    if (!generic && runtimeId !== 'hermes' && runtimeId !== 'openclaw') continue;
    if (!knownOwned(path) || !existsSync(path)) continue;
    // Absolute executable/session arguments are not credential selections.
    if (args.includes(path) && !/^(?:auth(?:-profiles|-state)?\.json|(?:config|settings(?:\.local)?)\.(?:json|toml|ya?ml)|openclaw\.json|\.env|models_dev_cache\.json)$/.test(basename(path))) continue;
    warn(path);
    throw refusal();
  }
}
