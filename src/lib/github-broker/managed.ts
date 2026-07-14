import 'server-only';

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Managed GitHub App state (the Cursor-style path).
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
 * RESIDUAL (documented, not yet closed): the anchor is process-global, not
 * request-bound. o8 in production runs ONE bundled Next server per OS user, with
 * ~/.o8 at 0700, so "the currently signed-in user" is unambiguous. The only way
 * to see A served B's token is TWO Next processes sharing CORTEX_IDE_DATA_DIR
 * with TWO different users signed in at once (a dev-bridge / shared-account
 * oddity, not a real deployment). Fully closing it needs the panel routes to
 * carry the caller's Clerk identity to the broker — a larger change tracked
 * separately. Everything a single-process desktop can hit fails closed.
 */

export interface ManagedGithubState {
  installed: boolean;
  token?: string;
  expiresAt?: string;
  installationId?: number;
  accountLogin?: string;
  /** The license-server-verified Clerk subject this token belongs to. */
  ownerClerkUserId?: string;
  /** Where "Install the o8 GitHub App" should send the user (from the server). */
  installUrl?: string;
  fetchedAt: string;
}

function dataDir(): string {
  return process.env.CORTEX_IDE_DATA_DIR || join(homedir(), '.o8');
}

function statePath(): string {
  return join(dataDir(), 'github-app-managed.json');
}

function activeIdentityPath(): string {
  return join(dataDir(), 'active-identity');
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
  if (!clerkUserId) return;
  try {
    const p = activeIdentityPath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `${clerkUserId}\n`, { mode: 0o600 });
    hardenPermissions(p);
  } catch (err) {
    console.error('[github-managed] failed to persist active identity:', err);
  }
}

export function clearActiveIdentity(): void {
  try {
    rmSync(activeIdentityPath(), { force: true });
  } catch {
    /* already gone */
  }
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

/** Best-effort tighten to 0600 — writeFileSync's mode does NOT repair the perms
 * of a pre-existing looser file (audit #7). chmod does. */
function hardenPermissions(p: string): void {
  try {
    chmodSync(p, 0o600);
  } catch {
    /* non-POSIX or race — the create-time mode still applies */
  }
}

export function writeManagedGithubState(state: Omit<ManagedGithubState, 'fetchedAt'>): void {
  try {
    const p = statePath();
    mkdirSync(dirname(p), { recursive: true });
    // Atomic write: a full token write must never be observed half-flushed by a
    // concurrent reader (two Next processes can race the 15-min focus sync).
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...state, fetchedAt: new Date().toISOString() }, null, 2), {
      mode: 0o600,
    });
    hardenPermissions(tmp);
    renameSync(tmp, p);
    hardenPermissions(p);
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
