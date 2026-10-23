import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveNotarizationCredentials, stapleAndValidate, submitForNotarization } from '../scripts/lib/notarization.mjs';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.doUnmock('node:child_process');
  vi.doUnmock('node:fs');
});

describe('release notarization helpers', () => {
  it('selects a Keychain profile without reading any fallback credentials', () => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', APPLE_KEYCHAIN_PROFILE: 'test-profile' };
    for (const name of ['APPLE_ID', 'APPLE_TEAM_ID', 'APPLE_PASSWORD']) {
      Object.defineProperty(env, name, { get() { throw new Error('fallback credential read'); } });
    }
    expect(resolveNotarizationCredentials(env)).toEqual({ keychainProfile: 'test-profile' });
  });

  it('submits with a profile instead of the credential trio', () => {
    const run = vi.fn();
    submitForNotarization('/tmp/o8.dmg', { keychainProfile: 'test-profile' }, run);
    expect(run).toHaveBeenCalledWith('xcrun', [
      'notarytool', 'submit', '/tmp/o8.dmg', '--keychain-profile', 'test-profile', '--wait',
    ], { stdio: 'pipe' });
  });

  it('resolves legacy credentials only when no profile is configured', () => {
    expect(resolveNotarizationCredentials({
      NODE_ENV: 'test', APPLE_KEYCHAIN_PROFILE: '  ', APPLE_ID: 'test@example.invalid',
      APPLE_TEAM_ID: 'TESTTEAM', APPLE_PASSWORD: 'synthetic-password',
    })).toEqual({ appleId: 'test@example.invalid', teamId: 'TESTTEAM', password: 'synthetic-password' });
    expect(() => resolveNotarizationCredentials({ NODE_ENV: 'test' })).toThrow('APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID');
  });

  it.each(['profile', 'legacy'])('suppresses raw %s command errors when no diagnostic streams were captured', (mode) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const run = vi.fn((_command: string, _args: string[], _options: { stdio: 'inherit' | 'pipe' }) => {
      throw new Error('synthetic-password test-profile test@example.invalid TESTTEAM');
    });
    const credentials = mode === 'profile' ? { keychainProfile: 'test-profile' } : {
      appleId: 'test@example.invalid', teamId: 'TESTTEAM', password: 'synthetic-password',
    };
    let failure: unknown;
    try { submitForNotarization('/tmp/o8.dmg', credentials, run); } catch (caught) { failure = caught; }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toMatch(/synthetic-password|test-profile|test@example.invalid|TESTTEAM/);
    expect([log.mock.calls, warn.mock.calls, error.mock.calls]).toEqual([[], [], []]);
    expect(run.mock.calls[0]?.[2]).toEqual({ stdio: 'pipe' });
  });

  it.each(['profile', 'legacy'])('prints redacted %s failure diagnostics when a fake command echoes its arguments', (mode) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const credentials = mode === 'profile' ? { keychainProfile: 'profile-$&-[secret].*' } : {
      appleId: 'release-TEST@example.invalid', teamId: 'TEST', password: 'fake-$&-[secret].*',
    };
    const run = vi.fn((command: string, args: string[]) => {
      const echoed = `${command} ${args.join(' ')}`;
      throw Object.assign(new Error(`Command failed: ${echoed}`), {
        stdout: Buffer.from(`Invalid signature: ${echoed}\nRepeated: ${echoed}\n`),
        stderr: `Bad bundle: ${echoed}\n`,
      });
    });

    expect(() => submitForNotarization('/tmp/o8.dmg', credentials, run)).toThrow('notarization submission failed');

    expect(run).toHaveBeenCalledWith('xcrun', expect.any(Array), { stdio: 'pipe' });
    expect(error).toHaveBeenNthCalledWith(1, expect.stringContaining('Invalid signature:'));
    expect(error).toHaveBeenNthCalledWith(2, expect.stringContaining('Bad bundle:'));
    const output = JSON.stringify([error.mock.calls, log.mock.calls, warn.mock.calls]);
    expect(output).toContain('/tmp/o8.dmg');
    expect(output).toContain('[REDACTED]');
    for (const value of Object.values(credentials)) expect(output).not.toContain(value);
  });

  it('the signing entry point accepts a profile without reading the password or requiring the trio', async () => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', APPLE_KEYCHAIN_PROFILE: 'test-profile', APPLE_SIGNING_IDENTITY: 'test-identity', HOME: '/fixture' };
    Object.defineProperty(env, 'APPLE_PASSWORD', { get() { throw new Error('password read'); } });
    const exit = vi.fn(() => { throw new Error('fixture stopped before signing'); });
    vi.stubGlobal('process', { ...process, env, argv: ['node', 'scripts/sign-and-notarize.mjs'], exit });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const run = vi.fn(() => JSON.stringify({ version: '0.1.999' }));
    vi.doMock('node:child_process', async (original) => ({ ...await original<typeof import('node:child_process')>(), execFileSync: run }));
    vi.doMock('node:fs', async (original) => ({ ...await original<typeof import('node:fs')>(), existsSync: () => false }));
    const script = '../scripts/sign-and-notarize.mjs';
    await expect(import(script)).rejects.toThrow('fixture stopped before signing');
    expect(error.mock.calls.flat().join(' ')).toContain('missing .app');
    expect(run.mock.calls).toHaveLength(1);
  });

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
