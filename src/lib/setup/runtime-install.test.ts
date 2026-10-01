import { readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { getRuntimeInstallInfo } from './runtime-install';

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : [path];
  });
}

describe('runtime install metadata', () => {
  it('does not reference the nonexistent Codex CLI npm package under src', () => {
    const root = join(process.cwd(), 'src');
    const legacyPackage = ['@openai', 'codex-cli'].join('/');
    const offenders = sourceFiles(root).filter((path) => {
      const extension = extname(path);
      if (!['.ts', '.tsx', '.js', '.jsx', '.md'].includes(extension)) return false;
      return readFileSync(path, 'utf8').includes(legacyPackage);
    });
    expect(offenders).toEqual([]);
  });

  it('routes free Google accounts to Antigravity instead of the Gemini npm package', () => {
    expect(getRuntimeInstallInfo('antigravity')).toMatchObject({
      label: 'Antigravity CLI',
      link: 'https://antigravity.google/docs/getting-started?tab=cli',
    });
    expect(getRuntimeInstallInfo('gemini')?.hint).toContain('enterprise and paid API access');
  });

  it('routes missing 3code users to the official setup page', () => {
    expect(getRuntimeInstallInfo('3code')).toEqual({
      id: '3code',
      label: '3code CLI',
      link: 'https://3code.capocasa.dev/',
      hint: 'Install 3code, then run it once to configure a model provider.',
    });
  });

  it('provides the official Magnitude npm install command', () => {
    expect(getRuntimeInstallInfo('magnitude')).toEqual({
      id: 'magnitude',
      label: 'Magnitude CLI',
      command: 'npm i -g @magnitudedev/cli',
      hint: 'On macOS or Linux, install Magnitude, then launch it in a visible repository terminal to choose a local model or custom endpoint.',
    });
  });
});
