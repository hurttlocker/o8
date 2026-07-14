import { createPrivateKey } from 'node:crypto';

import { SignJWT } from 'jose';
import type { Context } from 'hono';

import { clerkBackend } from './clerk-backend.js';
import { env } from './env.js';
import { verifyClerkSession } from './clerk-verify.js';

/**
 * Managed GitHub App broker (the Cursor-style integration).
 *
 * One PUBLIC GitHub App ("o8") is owned by us; users click Install on GitHub
 * and pick their repos. A desktop app can never hold the App's private key, so
 * THIS server holds it and mints short-lived installation tokens on demand:
 *
 *   POST /github/app/token   (Bearer = the caller's Clerk session token)
 *     → { installed: true, token, expiresAt, installationId, accountLogin }
 *     → { installed: false, installUrl }        (signed in, app not installed)
 *
 * The caller is mapped to their installation via their GitHub identity: Clerk
 * gives us the caller's immutable GitHub account id (clerk-backend), and we
 * find the App installation whose account matches. No registration callback,
 * no state to keep in sync — GitHub's installation list IS the truth.
 *
 * Scope guarantee: a user can only ever mint a token for an installation on
 * THEIR OWN GitHub account. Org installations are matched only when the org
 * account id equals the caller's — org support beyond that is a later, explicit
 * membership check, never an accidental grant.
 */

const GITHUB_API = 'https://api.github.com';

function appConfigured(): boolean {
  return !!(env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY);
}

/** App-auth JWT (RS256, ≤10 min) — authenticates as the App itself. GitHub
 * downloads App keys as PKCS1 ("BEGIN RSA PRIVATE KEY"); node:crypto accepts
 * both PKCS1 and PKCS8, unlike jose's importPKCS8. */
async function appJwt(): Promise<string> {
  const key = createPrivateKey(env.GITHUB_APP_PRIVATE_KEY);
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 540)
    .setIssuer(env.GITHUB_APP_ID)
    .sign(key);
}

type Installation = { id: number; accountId: string; accountLogin: string };

// Installation list cache (60s): the mapping changes only when someone
// installs/uninstalls, and every desktop token refresh would otherwise pay a
// paginated /app/installations walk.
let installationsCache: { at: number; list: Installation[] } | null = null;
const INSTALLATIONS_TTL_MS = 60 * 1000;

async function listInstallations(): Promise<Installation[]> {
  if (installationsCache && Date.now() - installationsCache.at < INSTALLATIONS_TTL_MS) {
    return installationsCache.list;
  }
  const jwt = await appJwt();
  const list: Installation[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const res = await fetch(`${GITHUB_API}/app/installations?per_page=100&page=${page}`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok) throw new Error(`GET /app/installations → HTTP ${res.status}`);
    const rows = (await res.json()) as {
      id: number;
      account?: { id?: number; login?: string } | null;
    }[];
    for (const r of rows) {
      if (!r?.id || !r.account?.id) continue;
      list.push({
        id: r.id,
        accountId: String(r.account.id),
        accountLogin: r.account.login ?? '',
      });
    }
    if (rows.length < 100) break;
  }
  installationsCache = { at: Date.now(), list };
  return list;
}

// Token cache per installation: GitHub installation tokens live 1h; reuse
// until 5 min before expiry so a fleet of desktop refreshes shares one mint.
const tokenCache = new Map<number, { token: string; expiresAt: string }>();

async function mintInstallationToken(
  installationId: number,
): Promise<{ token: string; expiresAt: string }> {
  const hit = tokenCache.get(installationId);
  if (hit && Date.parse(hit.expiresAt) - Date.now() > 5 * 60 * 1000) return hit;
  const jwt = await appJwt();
  const res = await fetch(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) throw new Error(`POST access_tokens(${installationId}) → HTTP ${res.status}`);
  const body = (await res.json()) as { token?: string; expires_at?: string };
  if (!body.token || !body.expires_at) throw new Error('access_tokens: malformed response');
  const value = { token: body.token, expiresAt: body.expires_at };
  tokenCache.set(installationId, value);
  return value;
}

function installUrl(): string {
  return env.GITHUB_APP_SLUG
    ? `https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new`
    : '';
}

/** Test/ops seam — drop both caches (mirrors clearClerkBackendCache). */
export function clearGithubAppCaches(): void {
  installationsCache = null;
  tokenCache.clear();
}

export async function handleGithubAppToken(c: Context): Promise<Response> {
  if (!appConfigured()) return c.json({ error: 'github_app_not_configured' }, 503);
  if (!env.CLERK_ISSUER) return c.json({ error: 'account_fetch_not_configured' }, 503);

  const authHeader = c.req.header('authorization');
  const sessionToken = authHeader?.replace(/^Bearer\s+/i, '').trim() ?? null;
  const clerkUserId = await verifyClerkSession(sessionToken);
  if (!clerkUserId) return c.json({ error: 'unauthorized' }, 401);

  const gh = await clerkBackend.resolveGithubAccount(clerkUserId);
  if (!gh) return c.json({ error: 'no_github_identity' }, 409);

  try {
    const installations = await listInstallations();
    const mine = installations.find((i) => i.accountId === gh.githubAccountId);
    if (!mine) return c.json({ installed: false, installUrl: installUrl() });

    const minted = await mintInstallationToken(mine.id);
    return c.json({
      installed: true,
      token: minted.token,
      expiresAt: minted.expiresAt,
      installationId: mine.id,
      accountLogin: mine.accountLogin,
    });
  } catch (err) {
    console.error('[github-app] token mint failed:', err instanceof Error ? err.message : err);
    return c.json({ error: 'github_app_upstream' }, 502);
  }
}
