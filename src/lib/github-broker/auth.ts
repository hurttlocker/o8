import 'server-only';

import { createHmac, createPrivateKey, timingSafeEqual } from 'node:crypto';
import { SignJWT } from 'jose';
import { getGitHubAppConfig, requireGitHubAppConfig } from './env';
import { readManagedGithubToken } from './managed';

const INSTALLATION_TOKEN_TTL_SKEW_MS = 60_000;
const installationTokenCache = new Map<number, { token: string; expiresAtMs: number }>();

function githubHeaders(token: string, extra?: HeadersInit): HeadersInit {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'o8-github-broker',
    'X-GitHub-Api-Version': '2022-11-28',
    ...extra,
  };
}

async function createAppJwt() {
  const config = requireGitHubAppConfig();
  const privateKey = createPrivateKey(config.privateKey);
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 9 * 60)
    .setIssuer(config.appId)
    .sign(privateKey);
}

async function githubAppFetch(path: string, init?: RequestInit) {
  const config = requireGitHubAppConfig();
  const jwt = await createAppJwt();
  return fetch(`${config.apiBaseUrl}${path}`, {
    ...init,
    headers: githubHeaders(jwt, init?.headers),
    cache: 'no-store',
  });
}

function buildGitHubError(response: Response, bodyText: string) {
  const reset = response.headers.get('x-ratelimit-reset');
  const retryAfter = response.headers.get('retry-after');
  const remaining = response.headers.get('x-ratelimit-remaining');
  const pieces = [`GitHub request failed (${response.status})`];

  if (bodyText) pieces.push(bodyText.trim());
  if (remaining) pieces.push(`remaining=${remaining}`);
  if (retryAfter) pieces.push(`retryAfter=${retryAfter}s`);
  if (reset) pieces.push(`resetAt=${new Date(Number(reset) * 1000).toISOString()}`);

  return new Error(pieces.join(' · '));
}

export async function getInstallationForRepo(repoFullName: string) {
  // Managed mode: no BYO app key on this machine — there is exactly ONE
  // installation (the signed-in user's, minted by the license server). We
  // can't call /repos/:repo/installation without an app JWT; a repo outside
  // the user's installation just 404s downstream with the token, which the
  // existing error surface already reports.
  if (!getGitHubAppConfig()) {
    const managed = readManagedGithubToken();
    if (managed) {
      return {
        id: managed.installationId,
        account: managed.accountLogin ? { login: managed.accountLogin } : undefined,
      } as { id: number; target_type?: string; permissions?: Record<string, string>; account?: { login?: string; type?: string } };
    }
  }
  const response = await githubAppFetch(`/repos/${repoFullName}/installation`);
  const text = await response.text();
  if (!response.ok) {
    throw buildGitHubError(response, text);
  }
  return JSON.parse(text) as {
    id: number;
    target_type?: string;
    permissions?: Record<string, string>;
    account?: { login?: string; type?: string };
  };
}

export async function getInstallationToken(installationId: number) {
  // Managed mode: the license server minted this token; use it as-is.
  if (!getGitHubAppConfig()) {
    const managed = readManagedGithubToken();
    if (managed && managed.installationId === installationId) return managed.token;
  }
  const cached = installationTokenCache.get(installationId);
  if (cached && (Date.now() + INSTALLATION_TOKEN_TTL_SKEW_MS) < cached.expiresAtMs) {
    return cached.token;
  }

  const response = await githubAppFetch(`/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
  });
  const text = await response.text();
  if (!response.ok) {
    throw buildGitHubError(response, text);
  }

  const data = JSON.parse(text) as { token: string; expires_at: string };
  installationTokenCache.set(installationId, {
    token: data.token,
    expiresAtMs: new Date(data.expires_at).getTime(),
  });
  return data.token;
}

export async function githubInstallationFetch(repoFullName: string, path: string, init?: RequestInit) {
  const installation = await getInstallationForRepo(repoFullName);
  const token = await getInstallationToken(installation.id);
  const config = requireGitHubAppConfig();
  const response = await fetch(`${config.apiBaseUrl}${path}`, {
    ...init,
    headers: githubHeaders(token, init?.headers),
    cache: 'no-store',
  });

  return { response, installation };
}

export function verifyGitHubWebhookSignature(rawBody: string, signatureHeader: string | null) {
  const config = requireGitHubAppConfig();
  if (!config.webhookSecret) {
    throw new Error('GitHub App webhook secret is not configured.');
  }
  if (!signatureHeader) return false;

  const digest = createHmac('sha256', config.webhookSecret).update(rawBody).digest('hex');
  const expected = `sha256=${digest}`;
  const actual = signatureHeader;
  if (expected.length !== actual.length) return false;

  return timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

