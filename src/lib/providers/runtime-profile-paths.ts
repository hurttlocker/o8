import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export function canonicalProfilePath(file: string): string {
  const absolute = resolve(file);
  try { return realpathSync(absolute); } catch {
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(canonicalProfilePath(parent), basename(absolute));
  }
}

export function profileContains(root: string, file: string): boolean {
  const path = relative(canonicalProfilePath(root), canonicalProfilePath(file));
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/** Explicit selectors override implicit homes, as they do in the runtime. */
export function selectedRuntimeProfiles(runtimeId: string | undefined, env: Record<string, string | undefined>, args: readonly string[], cwd = process.cwd()): string[] {
  // Codex home/auth handling remains main's contract (#4334).
  if (runtimeId === 'codex') return [];
  const absolute = (file: string) => canonicalProfilePath(resolve(cwd, file));
  const home = absolute(env.HOME || homedir());
  const profileIndex = args.indexOf('--profile');
  const openclawHome = join(home, profileIndex >= 0 && args[profileIndex + 1] ? `.openclaw-${args[profileIndex + 1]}` : '.openclaw');
  const profiles: Record<string, string[]> = {
    hermes: [env.HERMES_HOME || join(home, '.hermes')],
    'claude-code': [env.CLAUDE_CONFIG_DIR || join(home, '.claude')],
    gemini: [env.GEMINI_CLI_HOME || join(home, '.gemini')],
    openclaw: [env.OPENCLAW_STATE_DIR || openclawHome, env.OPENCLAW_CONFIG_PATH].filter((path): path is string => !!path),
  };
  // An unknown ACP implementation may ignore a selector and use HOME directly.
  const selected = !runtimeId || runtimeId === 'acp'
    ? [...Object.values(profiles).flat(), ...['.hermes', '.claude', '.gemini', '.openclaw', '.openclaw-o8'].map(name => join(home, name))]
    : profiles[runtimeId] ?? [];
  return [...new Set(selected.map(absolute))];
}
