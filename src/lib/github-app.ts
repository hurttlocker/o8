/**
 * GitHub App authentication — generates installation tokens from PEM key.
 * 15,000 req/hr per installation (vs 5,000 PAT / 60 unauthenticated).
 *
 * Config: ~/.o8/github-app.pem + app ID + installation ID
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createSign } from 'crypto';
import { getDataDir } from '@/lib/data-dir-migration';

const CONFIG_DIR = getDataDir();
const PEM_PATH = join(CONFIG_DIR, 'github-app.pem');

// NOTE: no fallback values. A fresh clone without GITHUB_APP_ID set returns
// null from this module so callers know to fall through to the unauth /
// device-flow path instead of silently hitting some other account's app.
const APP_ID = process.env.GITHUB_APP_ID?.trim() || null;
const INSTALLATION_ID = process.env.GITHUB_APP_INSTALLATION_ID?.trim() || null;

// Cache the installation token (valid for 1 hour, refresh at 50min)
let _token: string | null = null;
let _tokenExpiresAt = 0;

/** Create a JWT signed with the app's private key */
function createJWT(): string | null {
  if (!APP_ID) return null;
  if (!existsSync(PEM_PATH)) return null;

  const pem = readFileSync(PEM_PATH, 'utf-8');
  const now = Math.floor(Date.now() / 1000);

  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iat: now - 60,      // issued 60s ago (clock skew)
    exp: now + 600,     // expires in 10min
    iss: APP_ID,
  })).toString('base64url');

  const sign = createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const signature = sign.sign(pem, 'base64url');

  return `${header}.${payload}.${signature}`;
}

/** Get a fresh installation access token (cached for ~50min) */
export async function getInstallationToken(): Promise<string | null> {
  if (!APP_ID || !INSTALLATION_ID) return null;

  // Return cached token if still valid
  if (_token && Date.now() < _tokenExpiresAt) {
    return _token;
  }

  const jwt = createJWT();
  if (!jwt) return null;

  try {
    const res = await fetch(
      `https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );

    if (!res.ok) {
      console.error(`GitHub App token error: ${res.status} ${await res.text()}`);
      return null;
    }

    const data = await res.json();
    _token = data.token;
    // Refresh 10 min before expiry
    _tokenExpiresAt = Date.now() + 50 * 60 * 1000;
    return _token;
  } catch (e) {
    console.error('GitHub App token fetch failed:', e);
    return null;
  }
}

/** Check if GitHub App is configured (env + pem file present) */
export function isGitHubAppConfigured(): boolean {
  return Boolean(APP_ID && INSTALLATION_ID && existsSync(PEM_PATH));
}
