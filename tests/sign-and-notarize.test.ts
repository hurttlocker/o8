import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stapleAndValidate, submitForNotarization } from '../scripts/lib/notarization.mjs';

describe('release notarization helpers', () => {
  it('submits an artifact with the configured Apple credentials and waits', () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const run = (command: string, args: string[]) => {
      calls.push({ command, args });
    };

    submitForNotarization('/tmp/o8.dmg', {
      appleId: 'release@example.com',
      teamId: 'TEAMID',
      password: 'app-password',
    }, run);

    expect(calls).toEqual([{
      command: 'xcrun',
      args: [
        'notarytool', 'submit', '/tmp/o8.dmg',
        '--apple-id', 'release@example.com',
        '--team-id', 'TEAMID',
        '--password', 'app-password',
        '--wait',
      ],
    }]);
  });

  it('staples and validates the same artifact', () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const run = (command: string, args: string[]) => {
      calls.push({ command, args });
    };

    stapleAndValidate('/tmp/o8.dmg', run);

    expect(calls).toEqual([
      { command: 'xcrun', args: ['stapler', 'staple', '/tmp/o8.dmg'] },
      { command: 'xcrun', args: ['stapler', 'validate', '/tmp/o8.dmg'] },
    ]);
  });

  it('notarizes the final DMG after signing and before publication', () => {
    const script = readFileSync(join(process.cwd(), 'scripts/sign-and-notarize.mjs'), 'utf8');
    const signed = script.indexOf("console.log('[sign-and-notarize] signing DMG')");
    const submitted = script.indexOf("console.log('[sign-and-notarize] submitting signed DMG");
    const stapled = script.indexOf("console.log('[sign-and-notarize] stapling and validating DMG");
    const done = script.indexOf("console.log('[sign-and-notarize] done. app and DMG are notarized");

    expect(signed).toBeGreaterThanOrEqual(0);
    expect(submitted).toBeGreaterThan(signed);
    expect(stapled).toBeGreaterThan(submitted);
    expect(done).toBeGreaterThan(stapled);
  });
});
