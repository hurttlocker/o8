import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

/**
 * The local-worker token — a distinct credential from the shared ws-token,
 * stamped into every DISPATCHED worker's environment as O8_WORKER_TOKEN. A
 * caller presenting it identifies itself as a worker, so governance routes can
 * deny it (a worker must not resolve its own approval — SECURITY_AUDIT
 * 2026-07-02 §CRIT-1). The operator webview, the orchestrator MCP (ws-token),
 * and a human running `o8` manually never present it, so they stay 'operator'.
 *
 * Two-tier note: a MALICIOUS same-uid worker could read ~/.o8/ws-token and
 * impersonate the operator. This (Tier-1) stops the prompt-injected worker that
 * drives the CLI; true isolation is the Tier-2 sandbox.
 */
const DATA_DIR = getDataDir();
export const LOCAL_WORKER_TOKEN_PATH = path.join(DATA_DIR, 'worker-token');
const TOKEN_LENGTH = 32; // 256-bit
const MIN_TOKEN_LENGTH = 16;

function readStored(): string | null {
  try {
    if (!existsSync(LOCAL_WORKER_TOKEN_PATH)) return null;
    const existing = readFileSync(LOCAL_WORKER_TOKEN_PATH, 'utf8').trim();
    return existing.length >= MIN_TOKEN_LENGTH ? existing : null;
  } catch {
    return null;
  }
}

/** Mint-once (0600) local-worker token; call at dispatch to stamp the worker env. */
export function getOrCreateLocalWorkerToken(): string {
  const existing = readStored();
  if (existing) return existing;

  const token = randomBytes(TOKEN_LENGTH).toString('hex');
  mkdirSync(DATA_DIR, { recursive: true });
  try {
    writeFileSync(LOCAL_WORKER_TOKEN_PATH, token, { flag: 'wx', mode: 0o600 });
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const concurrent = readStored();
      if (concurrent) return concurrent;
    }
    writeFileSync(LOCAL_WORKER_TOKEN_PATH, token, { mode: 0o600 });
    return token;
  }
}

/** True if `presented` is the active local-worker token (constant-time). */
export function isLocalWorkerToken(presented: string | null | undefined): boolean {
  if (!presented) return false;
  const stored = readStored();
  if (!stored) return false;
  const a = Buffer.from(presented, 'utf-8');
  const b = Buffer.from(stored, 'utf-8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
