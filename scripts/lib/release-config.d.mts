export interface ReleaseConfig {
  githubOAuthClientId: string;
  clerkPublishableKey: string;
  sentryDsn: string;
}

export function resolveReleaseConfig(
  root: string,
  env?: Readonly<Record<string, string | undefined>>,
): ReleaseConfig;
