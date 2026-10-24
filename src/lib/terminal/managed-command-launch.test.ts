import { afterAll, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedCommandLaunch } from './managed-command-launch';
const dir = mkdtempSync(join(tmpdir(), 'o8-resolved-shell-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
it.skipIf(process.platform === 'win32')('resolved worker exec skips startup files that restore removed provider aliases', () => {
  const shell = join(dir, 'login-shell');
  writeFileSync(shell, '#!/bin/sh\nexport GOOGLE_API_KEY=fixture-restored\nexec /bin/sh "$@"\n', { mode: 0o700 });
  const command = `${JSON.stringify(process.execPath)} -e 'process.stdout.write(JSON.stringify(process.env.GOOGLE_API_KEY||null))'`;
  const inherited = { HOME: dir, PATH: process.env.PATH };
  const legacy = managedCommandLaunch(shell, command, inherited, { GOOGLE_API_KEY: '' });
  expect(JSON.parse(execFileSync(legacy.file, legacy.args, { env: legacy.env, encoding: 'utf8' }))).toBe('fixture-restored');
  const resolved = managedCommandLaunch(shell, command, inherited, { GOOGLE_API_KEY: '' }, true);
  expect(JSON.parse(execFileSync(resolved.file, resolved.args, { env: resolved.env, encoding: 'utf8' }))).toBeNull();
  expect(resolved.args.join(' ')).not.toContain('fixture-restored');
});
it('Windows resolved launch refuses POSIX shell commands in favor of direct spawn', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try { expect(() => managedCommandLaunch('fixture-profile-shell', 'fixture-command', {}, {}, true)).toThrow('direct spawn'); }
  finally { Object.defineProperty(process, 'platform', platform); }
});
