import 'server-only';

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type RemoteRuntimeFlagSource = 'env' | 'file' | 'off';

export interface RemoteRuntimeFlagState {
  enabled: boolean;
  source: RemoteRuntimeFlagSource;
}

const FEATURE_FLAGS_FILE = 'feature-flags.json';

function getFeatureFlagsPath() {
  return path.join(
    process.env.CORTEX_IDE_DATA_DIR || path.join(os.homedir(), '.cortex-ide'),
    FEATURE_FLAGS_FILE,
  );
}

export async function getRemoteRuntimeFlag(): Promise<RemoteRuntimeFlagState> {
  if (process.env.O8_ENABLE_REMOTE_RUNTIME === '1') {
    return { enabled: true, source: 'env' };
  }

  try {
    const raw = await readFile(getFeatureFlagsPath(), 'utf8');
    const parsed = JSON.parse(raw) as { remoteRuntime?: unknown };
    if (typeof parsed.remoteRuntime === 'boolean') {
      return { enabled: parsed.remoteRuntime, source: 'file' };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[worker-flags] Failed to read feature flags:', error);
    }
  }

  return { enabled: false, source: 'off' };
}

export async function setRemoteRuntimeFlag(enabled: boolean): Promise<void> {
  const filePath = getFeatureFlagsPath();
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify({ remoteRuntime: enabled }, null, 2)}\n`, 'utf8');
}
