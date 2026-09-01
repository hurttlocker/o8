import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authFixture = vi.hoisted(() => ({
  home: '',
  claudeBinary: '',
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    default: {
      ...actual,
      homedir: () => authFixture.home,
    },
  };
});

vi.mock('./cli-locate', () => ({
  scanAndLink: vi.fn((binaryName: string) => (
    binaryName === 'claude' ? authFixture.claudeBinary : null
  )),
}));

authFixture.home = mkdtempSync(path.join(os.tmpdir(), 'o8-claude-auth-'));
authFixture.claudeBinary = path.join(
  authFixture.home,
  'test-bin',
  process.platform === 'win32' ? 'claude.cmd' : 'claude',
);
mkdirSync(path.dirname(authFixture.claudeBinary), { recursive: true });
if (process.platform === 'win32') {
  writeFileSync(authFixture.claudeBinary, [
    '@echo off',
    'if "%O8_TEST_CLAUDE_LOGGED_IN%"=="1" (',
    '  echo {"loggedIn":true}',
    ') else (',
    '  echo {"loggedIn":false}',
    ')',
  ].join('\r\n'));
} else {
  writeFileSync(authFixture.claudeBinary, [
    '#!/bin/sh',
    'if [ "$1" = "auth" ] && [ "$2" = "status" ] && [ "$3" = "--json" ]; then',
    '  if [ "${O8_TEST_CLAUDE_LOGGED_IN:-0}" = "1" ]; then',
    '    printf \'%s\\n\' \'{"loggedIn":true}\'',
    '  else',
    '    printf \'%s\\n\' \'{"loggedIn":false}\'',
    '  fi',
    '  exit 0',
    'fi',
    'exit 1',
  ].join('\n'));
  chmodSync(authFixture.claudeBinary, 0o755);
}

const dataRoot = mkdtempSync(path.join(os.tmpdir(), 'o8-claude-auth-route-'));
const priorDataEnv = {
  O8_DATA_DIR: process.env.O8_DATA_DIR,
  CORTEX_IDE_DATA_DIR: process.env.CORTEX_IDE_DATA_DIR,
};
process.env.O8_DATA_DIR = dataRoot;
process.env.CORTEX_IDE_DATA_DIR = dataRoot;

const {
  getRuntimeAuthSnapshot,
  invalidateRuntimeAuthCache,
} = await import('./auth-detect');
const operatorDefaultsRoute = await import('@/app/api/panel/operator-defaults/route');

beforeEach(() => {
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
  vi.stubEnv('O8_TEST_CLAUDE_LOGGED_IN', '0');
});

afterEach(() => {
  vi.unstubAllEnvs();
  invalidateRuntimeAuthCache();
  rmSync(path.join(authFixture.home, '.claude'), { recursive: true, force: true });
});

afterAll(() => {
  if (priorDataEnv.O8_DATA_DIR === undefined) delete process.env.O8_DATA_DIR;
  else process.env.O8_DATA_DIR = priorDataEnv.O8_DATA_DIR;
  if (priorDataEnv.CORTEX_IDE_DATA_DIR === undefined) delete process.env.CORTEX_IDE_DATA_DIR;
  else process.env.CORTEX_IDE_DATA_DIR = priorDataEnv.CORTEX_IDE_DATA_DIR;
  rmSync(authFixture.home, { recursive: true, force: true });
  rmSync(dataRoot, { recursive: true, force: true });
});

describe('Claude Code readiness preflight', () => {
  it('rejects stale local marker files when the CLI reports logged out', async () => {
    mkdirSync(path.join(authFixture.home, '.claude', 'projects'), { recursive: true });
    writeFileSync(path.join(authFixture.home, '.claude', 'settings.json'), '{}');
    writeFileSync(
      path.join(authFixture.home, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: '', refreshToken: '' } }),
    );
    invalidateRuntimeAuthCache();

    const snapshot = await getRuntimeAuthSnapshot();
    expect(snapshot.statuses.claude).toMatchObject({
      installed: true,
      ready: false,
      authenticated: false,
      unavailableReason: 'needs_auth',
      detail: 'Claude Code CLI is installed but not signed in.',
    });

    const response = await operatorDefaultsRoute.GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      dispatchableRuntimes: expect.arrayContaining([
        expect.objectContaining({
          id: 'claude-code',
          available: false,
          unavailableReason: 'needs_auth',
        }),
      ]),
    });
  });

  it('reports Claude Code ready when its auth command confirms the session', async () => {
    vi.stubEnv('O8_TEST_CLAUDE_LOGGED_IN', '1');
    invalidateRuntimeAuthCache();

    const snapshot = await getRuntimeAuthSnapshot();
    expect(snapshot.statuses.claude).toMatchObject({
      installed: true,
      ready: true,
      authenticated: true,
      unavailableReason: null,
      detail: 'Claude Code CLI is installed and signed in.',
    });
  });
});
