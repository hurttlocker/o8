import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = process.env.CORTEX_IDE_DATA_DIR || path.join(os.homedir(), '.cortex-ide');
export const WS_TOKEN_PATH = path.join(DATA_DIR, 'ws-token');
const TOKEN_LENGTH = 32; // 256-bit token
const MIN_TOKEN_LENGTH = 16;

export function getOrCreateWsToken(): string {
  const envToken = process.env.WS_TOKEN?.trim();
  if (envToken) return envToken;

  try {
    if (existsSync(WS_TOKEN_PATH)) {
      const existing = readFileSync(WS_TOKEN_PATH, 'utf8').trim();
      if (existing.length >= MIN_TOKEN_LENGTH) return existing;
    }
  } catch {
    // Ignore read errors and regenerate below.
  }

  const token = randomBytes(TOKEN_LENGTH).toString('hex');
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(WS_TOKEN_PATH, token, { mode: 0o600 });
  console.log(`[ws-auth] Generated new WS auth token at ${WS_TOKEN_PATH}`);
  return token;
}
