import 'server-only';

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  webhookSecret: string | null;
  apiBaseUrl: string;
  publicBaseUrl: string | null;
}

const DEFAULT_APP_ID = '3167857';
const DEFAULT_PEM_PATH = join(getDataDir(), 'github-app.pem');

function normalizePrivateKey(value: string) {
  return value.includes('\\n') ? value.replace(/\\n/g, '\n') : value;
}

export function getGitHubAppConfig(): GitHubAppConfig | null {
  const appId = process.env.GITHUB_APP_ID?.trim() || DEFAULT_APP_ID;
  const privateKeyRaw = process.env.GITHUB_APP_PRIVATE_KEY?.trim()
    || (existsSync(DEFAULT_PEM_PATH) ? readFileSync(DEFAULT_PEM_PATH, 'utf-8').trim() : '');

  if (!appId || !privateKeyRaw) {
    return null;
  }

  return {
    appId,
    privateKey: normalizePrivateKey(privateKeyRaw),
    webhookSecret: process.env.GITHUB_APP_WEBHOOK_SECRET?.trim() || null,
    apiBaseUrl: process.env.GITHUB_API_BASE_URL?.trim() || 'https://api.github.com',
    publicBaseUrl: process.env.CORTEX_IDE_PUBLIC_BASE_URL?.trim() || null,
  };
}

export function requireGitHubAppConfig(): GitHubAppConfig {
  const config = getGitHubAppConfig();
  if (!config) {
    throw new Error('GitHub App is not configured. Set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY.');
  }
  return config;
}

export function getGitHubWebhookUrl() {
  const config = getGitHubAppConfig();
  if (!config?.publicBaseUrl) return null;
  return `${config.publicBaseUrl.replace(/\/$/, '')}/api/github/webhook`;
}
