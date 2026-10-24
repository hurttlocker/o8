import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { generatedOutputLaunch } from '../scripts/lib/generated-output-launch.mjs';

const require = createRequire(import.meta.url);

describe('generated-output Node preload specifiers', () => {
  it.skipIf(process.platform !== 'win32')('converts a native Windows absolute loader path into a file URL', () => {
    const loaderPath = require.resolve('tsx');
    expect(loaderPath).toMatch(/^[A-Za-z]:\\/);

    const invocation = generatedOutputLaunch('prebuild');
    expect(invocation.args[3]).toMatch(/^file:\/\/\/[A-Za-z]:\//);
    expect(fileURLToPath(invocation.args[3])).toBe(loaderPath);
  });

  it.each(['prebuild', 'build', 'dev', 'start', 'postship'])('%s uses file URLs for both preloads', (mode) => {
    const invocation = generatedOutputLaunch(mode, ['--port', '4321']);

    expect(invocation.command).toBe(process.execPath);
    expect(invocation.args[0]).toBe('--import');
    expect(invocation.args[2]).toBe('--import');
    // Node resolves --import as an ESM specifier. On Windows a raw drive
    // path is interpreted as a URL with an unsupported drive-letter scheme.
    expect(invocation.args[1]).toMatch(/^file:\/\//);
    expect(invocation.args[3]).toMatch(/^file:\/\//);
    expect(fileURLToPath(invocation.args[1])).toBe(fileURLToPath(
      new URL('../scripts/register-server-only-stub.mjs', import.meta.url),
    ));
    expect(fileURLToPath(invocation.args[3])).toBe(require.resolve('tsx'));
    // The program entry is a filesystem argument, not a preload specifier.
    expect(invocation.args.slice(4)).toEqual([
      fileURLToPath(new URL('../scripts/generated-output-run.ts', import.meta.url)),
      mode, '--port', '4321',
    ]);
  });
});
