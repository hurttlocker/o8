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
  } catch (error) {
    const credentialValues = authentication
      .filter((value, index) => index % 2 === 1 && value)
      .sort((left, right) => right.length - left.length);
    for (const output of [error?.stdout, error?.stderr]) {
      if (typeof output !== 'string' && !Buffer.isBuffer(output)) continue;
      let diagnostic = output.toString();
      for (const value of credentialValues) {
        diagnostic = diagnostic.replaceAll(value, '[REDACTED]');
      }
      if (diagnostic) console.error(`[sign-and-notarize] ${diagnostic}`);
    }
    throw new Error('notarization submission failed');
  }
}

export function stapleAndValidate(artifact, run = execFileSync) {
  run('xcrun', ['stapler', 'staple', artifact], { stdio: 'inherit' });
  run('xcrun', ['stapler', 'validate', artifact], { stdio: 'inherit' });
}
