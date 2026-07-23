import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

const DATA_DIR = getDataDir();
export const WS_TOKEN_PATH = path.join(DATA_DIR, 'ws-token');
const TOKEN_LENGTH = 32; // 256-bit token
const MIN_TOKEN_LENGTH = 16;

function readStoredWsToken(): string | null {
  try {
    if (!existsSync(WS_TOKEN_PATH)) return null;
    const existing = readFileSync(WS_TOKEN_PATH, 'utf8').trim();
    return existing.length >= MIN_TOKEN_LENGTH ? existing : null;
  } catch {
    return null;
  }
}

export function getOrCreateWsToken(): string {
  const envToken = process.env.WS_TOKEN?.trim();
  if (envToken) return envToken;

  const existing = readStoredWsToken();
  if (existing) return existing;

  const token = randomBytes(TOKEN_LENGTH).toString('hex');
  mkdirSync(DATA_DIR, { recursive: true });

  try {
    writeFileSync(WS_TOKEN_PATH, token, { flag: 'wx', mode: 0o600 });
    console.log(`[ws-auth] Generated new WS auth token at ${WS_TOKEN_PATH}`);
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const concurrentToken = readStoredWsToken();
      if (concurrentToken) return concurrentToken;
    }
    writeFileSync(WS_TOKEN_PATH, token, { mode: 0o600 });
    console.log(`[ws-auth] Regenerated WS auth token at ${WS_TOKEN_PATH}`);
    return token;
  }
}
