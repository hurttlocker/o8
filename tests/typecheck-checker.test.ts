import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { resolveTypecheckChecker } from '../scripts/typecheck-checker.mjs';

function fixture(available: string[]) {
  const resolve = vi.fn((specifier: string) => {
    if (!available.includes(specifier)) throw new Error('MODULE_NOT_FOUND');
    return join('/fixture/node_modules', specifier);
  });
  return { resolve, stderr: vi.fn() };
}

it.each(['darwin', 'win32'])('falls back on unsupported %s-x64 with one stderr line', (platform) => {
  const options = fixture(['typescript/bin/tsc']);
  expect(resolveTypecheckChecker({ ...options, platform, arch: 'x64' })).toEqual({
    name: 'tsc', path: join('/fixture/node_modules', 'typescript/bin/tsc'),
  });
  expect(options.stderr.mock.calls).toEqual([
    [`tsrs has no ${platform}-x64 build; using tsc 5.8.2\n`],
  ]);
});

it.each([
  ['darwin', 'arm64', undefined, '@tsrs/darwin-arm64'],
  ['linux', 'x64', 'gnu', '@tsrs/linux-x64-gnu'],
  ['linux', 'arm64', 'musl', '@tsrs/linux-arm64-musl'],
])('uses an installed native package for %s-%s (%s)', (platform, arch, libc, nativePackage) => {
  const options = fixture([`${nativePackage}/package.json`, 'tsrs/package.json']);
  expect(resolveTypecheckChecker({ ...options, platform, arch, libc })).toEqual({
    name: 'tsrs', path: join('/fixture/node_modules', 'tsrs/bin/tsrs'),
  });
  expect(options.resolve).toHaveBeenCalledWith(`${nativePackage}/package.json`);
  expect(options.stderr).not.toHaveBeenCalled();
});

it('falls back when the matching Linux optional dependency is missing', () => {
  const options = fixture(['@tsrs/linux-x64-musl/package.json', 'typescript/bin/tsc']);
  expect(resolveTypecheckChecker({ ...options, platform: 'linux', arch: 'x64', libc: 'gnu' }).name).toBe('tsc');
  expect(options.stderr).toHaveBeenCalledExactlyOnceWith('tsrs has no linux-x64 build; using tsc 5.8.2\n');
});

it('refuses parity when tsrs is unavailable instead of comparing tsc to itself', () => {
  const options = fixture(['typescript/bin/tsc']);
  expect(() => resolveTypecheckChecker({
    ...options, platform: 'win32', arch: 'x64', allowFallback: false,
  })).toThrow('tsrs has no win32-x64 build; parity requires both tsc 5.8.2 and tsrs');
  expect(options.stderr).not.toHaveBeenCalled();
});
