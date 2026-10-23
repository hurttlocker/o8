import { execFileSync } from 'node:child_process';

export function resolveNotarizationCredentials(env = process.env) {
  const keychainProfile = env.APPLE_KEYCHAIN_PROFILE?.trim();
  if (keychainProfile) return { keychainProfile };

  const required = ['APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID'];
  const missing = required.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`missing notarization credentials: ${missing.join(', ')}`);
  }
  return { appleId: env.APPLE_ID, teamId: env.APPLE_TEAM_ID, password: env.APPLE_PASSWORD };
}

export function submitForNotarization(artifact, credentials, run = execFileSync) {
  const authentication = 'keychainProfile' in credentials ? [
    '--keychain-profile', credentials.keychainProfile,
  ] : [
    '--apple-id', credentials.appleId,
    '--team-id', credentials.teamId,
    '--password', credentials.password,
  ];
  try {
    // notarytool output and exec errors can contain authentication arguments.
    run('xcrun', ['notarytool', 'submit', artifact, ...authentication, '--wait'], { stdio: 'pipe' });
  } catch {
    throw new Error('notarization submission failed; verify the configured Keychain profile or Apple credentials');
  }
}

export function stapleAndValidate(artifact, run = execFileSync) {
  run('xcrun', ['stapler', 'staple', artifact], { stdio: 'inherit' });
  run('xcrun', ['stapler', 'validate', artifact], { stdio: 'inherit' });
}
