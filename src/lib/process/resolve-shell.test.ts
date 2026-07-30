import { describe, expect, it } from 'vitest';
import { resolveShell } from './resolve-shell';

describe('resolveShell', () => {
  it('prefers an existing configured shell', () => {
    expect(resolveShell('/custom/shell', (path) => path === '/custom/shell'))
      .toBe('/custom/shell');
  });

  it('falls through zsh to bash when SHELL is unset', () => {
    expect(resolveShell(undefined, (path) => path === '/bin/bash' || path === '/bin/sh'))
      .toBe('/bin/bash');
  });

  it('uses sh when no preferred candidate exists', () => {
    expect(resolveShell(undefined, () => false)).toBe('/bin/sh');
  });
});
