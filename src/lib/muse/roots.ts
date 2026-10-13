import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

function canonicalPath(value: string): string {
  try { return realpathSync(value); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = path.dirname(value);
    if (parent === value) throw error;
    return path.join(canonicalPath(parent), path.basename(value));
  }
}

/** Resolve roots at admission; stored roots must retain that exact association. */
export function museRoot(value: string, persisted = false, workspace?: string): string {
  if (!path.isAbsolute(value) || path.resolve(value) === path.parse(value).root) throw new Error('Muse state root must be an absolute user directory.');
  const normalized = canonicalPath(path.resolve(value));
  if (persisted && normalized !== value) throw new Error('Muse state root changed. Its session was preserved.');
  if (canonicalPath(path.join(normalized, 'muse')) !== path.join(normalized, 'muse')) throw new Error('Muse state directory was redirected.');
  if (workspace && (normalized === workspace || normalized.startsWith(`${workspace}${path.sep}`))) throw new Error('Muse account state must be outside the workspace.');
  return normalized;
}

export function captureMuseRuntimeConfig(config?: Record<string, string>): Record<string, string> {
  return { ...config,
    museConfigRoot: museRoot(process.env.XDG_CONFIG_HOME?.trim() || path.join(homedir(), '.config')),
    museDataRoot: museRoot(process.env.XDG_DATA_HOME?.trim() || path.join(homedir(), '.local', 'share')) };
}
