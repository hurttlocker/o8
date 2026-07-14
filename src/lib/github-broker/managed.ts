import 'server-only';

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Managed GitHub App state (the Cursor-style path).
 *
 * The public "o8" GitHub App is owned by us; the license server holds its
 * private key and mints short-lived installation tokens for signed-in users
 * (POST /github/app/token). The entitlement sync fetches one alongside the
 * license and persists it here; the broker reads it whenever the BYO env
 * config (GITHUB_APP_ID + pem) is absent. Tokens live 1 hour — the sync
 * refreshes on sign-in and the 15-minute focus cadence, so an active session
 * never sees an expired token, and an expired one just means "fall back to
 * device-flow OAuth / unauthenticated", never an error.
 */

export interface ManagedGithubState {
  installed: boolean;
  token?: string;
  expiresAt?: string;
  installationId?: number;
  accountLogin?: string;
  /** Where "Install the o8 GitHub App" should send the user (from the server). */
  installUrl?: string;
  fetchedAt: string;
}

function statePath(): string {
  const dir = process.env.CORTEX_IDE_DATA_DIR || join(homedir(), '.o8');
  return join(dir, 'github-app-managed.json');
}

export function readManagedGithubState(): ManagedGithubState | null {
  try {
    const p = statePath();
    if (!existsSync(p)) return null;
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as ManagedGithubState;
    if (typeof parsed?.installed !== 'boolean') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** The managed installation token, or null when absent/expiring (<2 min). */
export function readManagedGithubToken(): {
  token: string;
  installationId: number;
  accountLogin: string | null;
} | null {
  const state = readManagedGithubState();
  if (!state?.installed || !state.token || !state.expiresAt || !state.installationId) return null;
  if (Date.parse(state.expiresAt) - Date.now() < 2 * 60 * 1000) return null;
  return {
    token: state.token,
    installationId: state.installationId,
    accountLogin: state.accountLogin ?? null,
  };
}

export function writeManagedGithubState(state: Omit<ManagedGithubState, 'fetchedAt'>): void {
  try {
    const p = statePath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ ...state, fetchedAt: new Date().toISOString() }, null, 2), {
      mode: 0o600,
    });
  } catch (err) {
    console.error('[github-managed] failed to persist state:', err);
  }
}

export function clearManagedGithubState(): void {
  try {
    rmSync(statePath(), { force: true });
  } catch {
    /* already gone */
  }
}
