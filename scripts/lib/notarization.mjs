import { execFileSync } from 'node:child_process';

export function submitForNotarization(artifact, credentials, run = execFileSync) {
  run('xcrun', [
    'notarytool', 'submit', artifact,
    '--apple-id', credentials.appleId,
    '--team-id', credentials.teamId,
    '--password', credentials.password,
    '--wait',
  ], { stdio: 'inherit' });
}

export function stapleAndValidate(artifact, run = execFileSync) {
  run('xcrun', ['stapler', 'staple', artifact], { stdio: 'inherit' });
  run('xcrun', ['stapler', 'validate', artifact], { stdio: 'inherit' });
}
