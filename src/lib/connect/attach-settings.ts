import 'server-only';

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { getDataDir } from '@/lib/data-dir-migration';

const SETTINGS_FILE = 'connect-attach.json';

export interface ConnectAttachSetting {
  enabled: boolean;
  source: 'default' | 'file' | 'env';
  locked: boolean;
}

function parseBoolean(value: string | undefined): boolean | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'on' || normalized === 'true' || normalized === '1') return true;
  if (normalized === 'off' || normalized === 'false' || normalized === '0') return false;
  return null;
}

export function readConnectAttachSetting(options: {
  env?: Readonly<Record<string, string | undefined>>;
  dataDir?: string;
} = {}): ConnectAttachSetting {
  const env = options.env ?? process.env;
  const envValue = parseBoolean(env.O8_CONNECT_ATTACH);
  if (envValue !== null) {
    return { enabled: envValue, source: 'env', locked: true };
  }

  const dataDir = options.dataDir ?? getDataDir(env);
  try {
    const parsed = JSON.parse(
      readFileSync(path.join(dataDir, SETTINGS_FILE), 'utf8'),
    ) as { enabled?: unknown };
    if (typeof parsed.enabled === 'boolean') {
      return { enabled: parsed.enabled, source: 'file', locked: false };
    }
  } catch {
    // Missing or corrupt settings deliberately recover to OFF.
  }
  return { enabled: false, source: 'default', locked: false };
}

export function writeConnectAttachEnabled(
  enabled: boolean,
  options: { dataDir?: string } = {},
): ConnectAttachSetting {
  const dataDir = options.dataDir ?? getDataDir();
  const target = path.join(dataDir, SETTINGS_FILE);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(temporary, `${JSON.stringify({ enabled }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, target);
  return { enabled, source: 'file', locked: false };
}
