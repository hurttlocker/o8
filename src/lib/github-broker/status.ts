import 'server-only';

import { listRepos } from '@/lib/repos/registry';
import { getInstallationForRepo, getInstallationToken } from './auth';
import { getGitHubAppConfig, getGitHubWebhookUrl } from './env';
import { readManagedGithubState, readManagedGithubToken } from './managed';

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
  /** True when auth comes from the managed public "o8" App via the hosted o8 account service. */
  managed: boolean;
  /** Install page for the managed App, when known and not yet installed. */
  managedInstallUrl: string | null;
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
    // Managed path: the public "o8" App, tokens minted by the license server
    // during entitlement sync. No local key, no env vars, no diagnostics.
    const managedState = readManagedGithubState();
    if (managedState?.installed) {
      const live = readManagedGithubToken();
      return {
        configured: true,
        appId: null,
        privateKeyConfigured: true,
        webhookSecretConfigured: false,
        publicBaseUrlConfigured: false,
        webhookUrl: null,
        productionWebhookReady: false,
        installationReachable: Boolean(live),
        installationId: managedState.installationId ?? null,
        installationAccount: managedState.accountLogin ?? null,
        probeRepo,
        tokenReady: Boolean(live),
        authSource: 'github-app',
        note: live
          ? 'o8 GitHub App is installed and healthy.'
          : 'o8 GitHub App is installed — refreshing its token on the next sign-in sync.',
        managed: true,
        managedInstallUrl: null,
      };
    }
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
      managed: false,
      managedInstallUrl: managedState?.installUrl || null,
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
      managed: false,
      managedInstallUrl: null,
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
      managed: false,
      managedInstallUrl: null,
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
      managed: false,
      managedInstallUrl: null,
    };
  }
}
