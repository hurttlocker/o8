import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { getDataDir } from '@/lib/data-dir-migration';
import type { OperatorDefaults, OperatorDefaultsWithSources } from '@/lib/operator/defaults';
import {
  parseOperatorDefaultsToml,
  serializeOperatorDefaultsToml,
  writeFileAtomic,
} from './toml';

const LEGACY_DEFAULTS_FILE = 'operator-defaults.json';
const SETTINGS_TOML_FILE = 'settings.toml';

type FileOperatorDefaults = Partial<OperatorDefaults> & {
  defaultDispatchRuntimeExplicit?: boolean;
};

export interface OperatorDefaultsTomlState {
  path: string;
  text: string;
  error: string | null;
}

export function getLegacyOperatorDefaultsPath(): string {
  return path.join(getDataDir(), LEGACY_DEFAULTS_FILE);
}

export function getOperatorDefaultsTomlPath(): string {
  return path.join(getDataDir(), SETTINGS_TOML_FILE);
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function withExplicitRuntime(values: Partial<OperatorDefaults>): FileOperatorDefaults {
  return {
    ...values,
    defaultDispatchRuntimeExplicit: Object.prototype.hasOwnProperty.call(values, 'defaultDispatchRuntime'),
  };
}

export async function loadOperatorDefaultsFiles(
  parseLegacy: (raw: string) => FileOperatorDefaults,
): Promise<FileOperatorDefaults> {
  try {
    return withExplicitRuntime(parseOperatorDefaultsToml(await readFile(getOperatorDefaultsTomlPath(), 'utf8')));
  } catch (error) {
    if (!isMissingFile(error)) {
      console.error('[operator-defaults] Invalid settings.toml; using last-good defaults:', error);
    }
    try {
      return parseLegacy(await readFile(getLegacyOperatorDefaultsPath(), 'utf8'));
    } catch (fallbackError) {
      if (!isMissingFile(fallbackError)) {
        console.error('[operator-defaults] Failed to read last-good operator defaults:', fallbackError);
      }
      return {};
    }
  }
}

export function loadOperatorDefaultsFilesSync(
  parseLegacy: (raw: string) => FileOperatorDefaults,
): FileOperatorDefaults {
  try {
    return withExplicitRuntime(parseOperatorDefaultsToml(readFileSync(getOperatorDefaultsTomlPath(), 'utf8')));
  } catch (error) {
    if (!isMissingFile(error)) {
      console.error('[operator-defaults] Invalid settings.toml during sync read; using last-good defaults:', error);
    }
    try {
      return parseLegacy(readFileSync(getLegacyOperatorDefaultsPath(), 'utf8'));
    } catch (fallbackError) {
      if (!isMissingFile(fallbackError)) {
        console.error('[operator-defaults] Failed to read last-good operator defaults during sync read:', fallbackError);
      }
      return {};
    }
  }
}

export async function readOperatorDefaultsTomlForUpdate(): Promise<{
  raw: string | undefined;
  values: Partial<OperatorDefaults>;
}> {
  try {
    const raw = await readFile(getOperatorDefaultsTomlPath(), 'utf8');
    return { raw, values: parseOperatorDefaultsToml(raw) };
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    return { raw: undefined, values: {} };
  }
}

export async function readLegacyOperatorDefaults(): Promise<string | null> {
  try {
    return await readFile(getLegacyOperatorDefaultsPath(), 'utf8');
  } catch (error) {
    if (!isMissingFile(error)) {
      console.error('[operator-defaults] Failed to read existing operator defaults:', error);
    }
    return null;
  }
}

export async function getOperatorDefaultsTomlState(
  projection: OperatorDefaults,
): Promise<OperatorDefaultsTomlState> {
  const filePath = getOperatorDefaultsTomlPath();
  let raw: string | null = null;
  try {
    raw = await readFile(filePath, 'utf8');
    parseOperatorDefaultsToml(raw);
    return { path: filePath, text: raw, error: null };
  } catch (error) {
    if (!isMissingFile(error)) {
      return {
        path: filePath,
        text: raw ?? '',
        error: error instanceof Error ? error.message : 'settings.toml is invalid.',
      };
    }
  }
  return { path: filePath, text: serializeOperatorDefaultsToml(projection), error: null };
}

export async function persistOperatorDefaults(
  values: OperatorDefaults,
  stored: object,
  existingToml?: string,
): Promise<void> {
  await writeFileAtomic(
    getOperatorDefaultsTomlPath(),
    serializeOperatorDefaultsToml(values, existingToml),
  );
  await writeFileAtomic(getLegacyOperatorDefaultsPath(), `${JSON.stringify(stored, null, 2)}\n`);
}

export async function applyOperatorDefaultsTomlFile(
  raw: string,
  fallback: OperatorDefaults,
  resolve: () => Promise<OperatorDefaultsWithSources>,
): Promise<OperatorDefaultsWithSources> {
  const parsed = parseOperatorDefaultsToml(raw);
  const stored: Record<string, unknown> = { ...fallback, ...parsed };
  if (Object.prototype.hasOwnProperty.call(parsed, 'defaultDispatchRuntime')) {
    stored.defaultDispatchRuntimeExplicit = true;
  }
  await writeFileAtomic(getOperatorDefaultsTomlPath(), raw.endsWith('\n') ? raw : `${raw}\n`);
  await writeFileAtomic(getLegacyOperatorDefaultsPath(), `${JSON.stringify(stored, null, 2)}\n`);
  return resolve();
}
