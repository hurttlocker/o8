import 'server-only';

import { listRepos } from '@/lib/repos/registry';
import { getInstallationForRepo, getInstallationToken } from './auth';
import { getGitHubAppConfig, getGitHubWebhookUrl } from './env';

function normalizeRepoSlug(remoteUrl: string | null | undefined) {
  if (!remoteUrl) return null;
  const normalized = remoteUrl
    .replace(/\.git$/, '')
    .replace(/^git@github\.com:/, 'https://github.com/');
  const match = normalized.match(/github\.com\/([^/]+\/[^/]+)$/);
  return match?.[1] ?? null;
}

export interface GitHubBrokerStatus {
  configured: boolean;
  appId: string | null;
  privateKeyConfigured: boolean;
  webhookSecretConfigured: boolean;
  publicBaseUrlConfigured: boolean;
  webhookUrl: string | null;
  productionWebhookReady: boolean;
  installationReachable: boolean;
  installationId: number | null;
  installationAccount: string | null;
  probeRepo: string | null;
  tokenReady: boolean;
  authSource: 'github-app' | 'local-gh' | 'none';
  note: string;
}

async function resolveProbeRepo() {
  const registered = await listRepos().catch(() => []);
  const explicit = process.env.CORTEX_IDE_REVIEW_REPO?.trim();
  if (explicit) return explicit;
  for (const repo of registered) {
    const slug = normalizeRepoSlug(repo.remoteUrl);
    if (slug) return slug;
  }
  return null;
}

export async function getGitHubBrokerStatus(): Promise<GitHubBrokerStatus> {
  const config = getGitHubAppConfig();
  const probeRepo = await resolveProbeRepo();
  const webhookUrl = getGitHubWebhookUrl();

  if (!config) {
    return {
      configured: false,
      appId: null,
      privateKeyConfigured: false,
      webhookSecretConfigured: false,
      publicBaseUrlConfigured: false,
      webhookUrl: null,
      productionWebhookReady: false,
      installationReachable: false,
      installationId: null,
      installationAccount: null,
      probeRepo,
      tokenReady: false,
      authSource: 'none',
      note: 'GitHub App key is not configured yet.',
    };
  }

  if (!probeRepo) {
    return {
      configured: true,
      appId: config.appId,
      privateKeyConfigured: true,
      webhookSecretConfigured: Boolean(config.webhookSecret),
      publicBaseUrlConfigured: Boolean(config.publicBaseUrl),
      webhookUrl,
      productionWebhookReady: Boolean(config.webhookSecret && config.publicBaseUrl),
      installationReachable: false,
      installationId: null,
      installationAccount: null,
      probeRepo: null,
      tokenReady: false,
      authSource: 'github-app',
      note: 'GitHub App key is configured, but no GitHub-backed local repo is registered yet.',
    };
  }

  try {
    const installation = await getInstallationForRepo(probeRepo);
    await getInstallationToken(installation.id);
    return {
      configured: true,
      appId: config.appId,
      privateKeyConfigured: true,
      webhookSecretConfigured: Boolean(config.webhookSecret),
      publicBaseUrlConfigured: Boolean(config.publicBaseUrl),
      webhookUrl,
      productionWebhookReady: Boolean(config.webhookSecret && config.publicBaseUrl),
      installationReachable: true,
      installationId: installation.id,
      installationAccount: installation.account?.login ?? null,
      probeRepo,
      tokenReady: true,
      authSource: 'github-app',
      note: config.webhookSecret && config.publicBaseUrl
        ? 'GitHub App auth is healthy and webhook config can be completed in GitHub settings.'
        : 'GitHub App auth is healthy. Add the production public base URL and webhook secret to finish webhook-based sync.',
    };
  } catch (error) {
    return {
      configured: true,
      appId: config.appId,
      privateKeyConfigured: true,
      webhookSecretConfigured: Boolean(config.webhookSecret),
      publicBaseUrlConfigured: Boolean(config.publicBaseUrl),
      webhookUrl,
      productionWebhookReady: false,
      installationReachable: false,
      installationId: null,
      installationAccount: null,
      probeRepo,
      tokenReady: false,
      authSource: 'github-app',
      note: error instanceof Error ? error.message : 'GitHub App probe failed.',
    };
  }
}
