import 'server-only';

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mutateAccountState } from '@/lib/auth/account-state';
import { removeAccountFile, writeAccountFile } from '@/lib/auth/account-state-files';
import { getDataDir } from '@/lib/data-dir-migration';

/**
 * Managed GitHub App state (the managed path).
 *
 * The public "o8" GitHub App is owned by us; the license server holds its
 * private key and mints short-lived installation tokens for signed-in users
 * (POST /github/app/token). The entitlement sync fetches one alongside the
 * license and persists it here; the broker reads it whenever the BYO env
 * config (GITHUB_APP_ID + pem) is absent.
 *
 * ── Cross-account binding (audit #2) ──────────────────────────────────────────
 * The token grants repo write access, so it must ONLY ever be served back to the
 * identity it was minted for. Two mechanisms enforce that on a shared desktop:
 *   1. The state is stamped with `ownerClerkUserId` (the license server's VERIFIED
 *      subject, not a client claim).
 *   2. A separate `active-identity` anchor records who is currently signed in
 *      (from the license server's VERIFIED subject, never a client claim). The
 *      token is served only when owner === active identity; anything else (a
 *      late fire-and-forget write from a signed-out user, a failed refresh that
 *      left the prior user's token, a missing/legacy owner, a fresh sign-in that
 *      wiped state) FAILS CLOSED.
 *
 * Account transitions and token refresh commits share the installation account
 * lease. Broker reads still compare the token owner to the active desktop owner;
 * request-bound authorization remains the responsibility of each broker route.
 */

export interface ManagedGithubState {
  installed: boolean;
  token?: string;
  expiresAt?: string;
  installationId?: number;
  accountLogin?: string;
  /** The hosted o8 account service-verified Clerk subject this token belongs to. */
  ownerClerkUserId?: string;
  /** Where "Install the o8 GitHub App" should send the user (from the server). */
  installUrl?: string;
  fetchedAt: string;
}

function dataDir(): string {
  return getDataDir();
}

function statePath(): string {
  return join(dataDir(), 'github-app-managed.json');
}

function activeIdentityPath(): string {
  return join(dataDir(), 'active-identity');
}

function signInEpochPath(): string {
  return join(dataDir(), 'github-signin-epoch');
}

// Fresh sign-in changes this identity generation. Async refresh commits also
// compare the durable account journal while holding its installation-wide lease.

export function readSignInEpoch(): string | null {
  try {
    const raw = readFileSync(signInEpochPath(), 'utf-8').trim();
    return raw || null;
  } catch {
    return null;
  }
}

export function bumpSignInEpoch(): void {
  mutateAccountState(() => writeAccountFile(signInEpochPath(), `${randomUUID()}\n`));
}

// ── Active-identity anchor: who is signed into this desktop right now ──────────
// Written early in every entitlement sync and cleared on sign-out, so it flips
// the instant a different user signs in — independent of whether the managed
// token refresh for the new user succeeds.

export function readActiveIdentity(): string | null {
  try {
    const raw = readFileSync(activeIdentityPath(), 'utf-8').trim();
    return raw || null;
  } catch {
    return null;
  }
}

export function writeActiveIdentity(clerkUserId: string): void {
  if (!clerkUserId.trim()) throw new Error('Active identity is required.');
  mutateAccountState(() => writeAccountFile(activeIdentityPath(), `${clerkUserId}\n`));
}

export function clearActiveIdentity(): void {
  mutateAccountState(() => removeAccountFile(activeIdentityPath()));
}

// ── Managed token state ───────────────────────────────────────────────────────

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

/**
 * The managed installation token, or null when absent, expiring (<2 min), or
 * NOT bound to the currently-active desktop identity. The owner check is the
 * cross-account guard (audit #2): fail closed unless the persisted owner is
 * present AND equals the active identity.
 */
export function readManagedGithubToken(): {
  token: string;
  installationId: number;
  accountLogin: string | null;
} | null {
  const state = readManagedGithubState();
  if (!state?.installed || !state.token || !state.expiresAt || !state.installationId) return null;
  if (Date.parse(state.expiresAt) - Date.now() < 2 * 60 * 1000) return null;

  // Owner binding — the token is only ever for the signed-in user who minted it.
  const owner = state.ownerClerkUserId;
  const active = readActiveIdentity();
  if (!owner || !active || owner !== active) return null;

  return {
    token: state.token,
    installationId: state.installationId,
    accountLogin: state.accountLogin ?? null,
  };
}

export function writeManagedGithubState(state: Omit<ManagedGithubState, 'fetchedAt'>): void {
  mutateAccountState(() => writeAccountFile(statePath(),
    JSON.stringify({ ...state, fetchedAt: new Date().toISOString() }, null, 2)));
}

export function clearManagedGithubState(): void {
  mutateAccountState(() => removeAccountFile(statePath()));
}
