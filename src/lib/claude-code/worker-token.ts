import 'server-only';

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { getDataDir } from '@/lib/data-dir-migration';
import { decryptValue, encryptValue } from '@/lib/db/master-key';
import { hasClaudeEnvCredential } from './oauth-credential';

const TOKEN_FILE = 'native-worker-token.json';
export const WORKER_TOKEN_SETUP_HINT = 'Run `npm run worker:login` from the application source checkout to connect a dedicated worker token.';
export const requiresNativeWorkerToken = (): boolean => process.platform === 'darwin';

/** An inference token, never the operator login's refresh credential. */
export function isNativeWorkerToken(value: unknown): value is string {
  return typeof value === 'string' && /^sk-ant-oat01-[A-Za-z0-9_-]{40,256}$/.test(value);
}

export async function saveNativeWorkerToken(token: string): Promise<void> {
  if (!isNativeWorkerToken(token)) throw new Error('Invalid worker token format.');
  const encrypted = await encryptValue(token);
  const directory = getDataDir();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = path.join(directory, TOKEN_FILE);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ version: 1, ...encrypted }), { mode: 0o600, flag: 'wx' });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Parent-only decryption. Nothing is added to global env, run records, or argv. */
export async function readNativeWorkerToken(): Promise<string | null> {
  try {
    const stored = JSON.parse(await readFile(path.join(getDataDir(), TOKEN_FILE), 'utf8')) as {
      version?: unknown; ciphertext?: unknown; iv?: unknown;
    };
    if (stored.version !== 1 || typeof stored.ciphertext !== 'string' || typeof stored.iv !== 'string') return null;
    const token = await decryptValue(stored.ciphertext, stored.iv);
    return isNativeWorkerToken(token) ? token : null;
  } catch {
    return null;
  }
}

export async function nativeWorkerTokenEnv(): Promise<Record<string, string>> {
  // An explicitly configured credential keeps its existing precedence and billing route.
  if (hasClaudeEnvCredential()) return {};
  const token = await readNativeWorkerToken();
  return token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {};
}
