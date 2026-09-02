import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authFixture = vi.hoisted(() => ({
  home: '',
  claudeBinary: '',
  installed: true,
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    default: { ...actual, homedir: () => authFixture.home },
  };
});

vi.mock('./cli-locate', () => ({
  scanAndLink: vi.fn((binaryName: string) => (
    binaryName === 'claude' && authFixture.installed ? authFixture.claudeBinary : null
  )),
}));

authFixture.home = mkdtempSync(path.join(os.tmpdir(), 'o8-claude-auth-'));
authFixture.claudeBinary = path.join(authFixture.home, 'test-bin', 'claude');
mkdirSync(path.dirname(authFixture.claudeBinary), { recursive: true });

// A controllable stand-in for the real CLI. `O8_TEST_CLAUDE_MODE` selects which of the
// documented and undocumented answers the probe has to survive.
const MALFORMED_MARKER = 'o8-malformed-probe-payload';
writeFileSync(authFixture.claudeBinary, [
  '#!/bin/sh',
  'case "${O8_TEST_CLAUDE_MODE:-logged_out}" in',
  '  logged_in) printf \'%s\\n\' \'{"loggedIn":true}\' ;;',
  '  logged_out) printf \'%s\\n\' \'{"loggedIn":false}\' ;;',
  `  malformed) printf '%s\\n' 'Claude Code update available ${MALFORMED_MARKER}' ;;`,
  '  no_field) printf \'%s\\n\' \'{"account":"someone"}\' ;;',
  '  hang) sleep 20 ;;',
  '  crash) echo "boom" >&2; exit 3 ;;',
  'esac',
  'exit 0',
].join('\n'));
chmodSync(authFixture.claudeBinary, 0o755);

const dataRoot = mkdtempSync(path.join(os.tmpdir(), 'o8-claude-auth-data-'));
const repoPath = path.join(dataRoot, 'repo');
execFileSync('git', ['init', '-q', repoPath]);
const priorDataEnv = {
  O8_DATA_DIR: process.env.O8_DATA_DIR,
  CORTEX_IDE_DATA_DIR: process.env.CORTEX_IDE_DATA_DIR,
};
process.env.O8_DATA_DIR = dataRoot;
process.env.CORTEX_IDE_DATA_DIR = dataRoot;

const {
  DispatchPreflightError,
  assertRuntimeDispatchable,
  getDispatchableRuntimeAvailability,
  getRuntimeAuthSnapshot,
  invalidateRuntimeAuthCache,
} = await import('./auth-detect');
const { writeClaudeCodeWorkerProfile } = await import('@/lib/claude-code/worker-profile');
const createMissionRoute = await import('@/app/api/orchestrator/create-mission/route');

const claudeConfigDir = path.join(authFixture.home, '.claude');

async function claudeStatus() {
  invalidateRuntimeAuthCache();
  return (await getRuntimeAuthSnapshot()).statuses.claude;
}

/** Marker files Claude Code leaves behind after a sign-out. */
function writeStaleMarkers(credentials?: unknown) {
  mkdirSync(path.join(claudeConfigDir, 'projects'), { recursive: true });
  writeFileSync(path.join(claudeConfigDir, 'settings.json'), '{}');
  writeFileSync(
    path.join(claudeConfigDir, '.credentials.json'),
    JSON.stringify(credentials ?? { claudeAiOauth: { accessToken: '', refreshToken: '   ' } }),
  );
}

function createMissionRequest(issueNumber: number): NextRequest {
  return new NextRequest('http://localhost:3001/api/orchestrator/create-mission', {
    method: 'POST',
    headers: { host: 'localhost:3001' },
    body: JSON.stringify({
      clientMutationId: `create-claude-${issueNumber}`,
      repoPath,
      requestedRuntime: 'claude-code',
      issues: [{
        number: issueNumber,
        title: 'Claude readiness seam',
        body: 'Prove native sign-in verification through mission creation.',
        url: '',
      }],
    }),
  });
}

beforeEach(async () => {
  authFixture.installed = true;
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
  vi.stubEnv('CLAUDE_CONFIG_DIR', '');
  vi.stubEnv('O8_TEST_CLAUDE_MODE', 'logged_out');
  await writeClaudeCodeWorkerProfile({
    source: 'native', model: null, codexModel: null, repoSkillAllowlist: [],
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  invalidateRuntimeAuthCache();
  rmSync(claudeConfigDir, { recursive: true, force: true });
});

afterAll(() => {
  if (priorDataEnv.O8_DATA_DIR === undefined) delete process.env.O8_DATA_DIR;
  else process.env.O8_DATA_DIR = priorDataEnv.O8_DATA_DIR;
  if (priorDataEnv.CORTEX_IDE_DATA_DIR === undefined) delete process.env.CORTEX_IDE_DATA_DIR;
  else process.env.CORTEX_IDE_DATA_DIR = priorDataEnv.CORTEX_IDE_DATA_DIR;
  rmSync(authFixture.home, { recursive: true, force: true });
  rmSync(dataRoot, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('Claude Code native sign-in verification', () => {
  it('refuses stale marker files and empty OAuth fields as sign-in evidence', async () => {
    writeStaleMarkers();

    const status = await claudeStatus();
    expect(status).toMatchObject({
      installed: true,
      ready: false,
      authenticated: false,
      unavailableReason: 'needs_auth',
      detail: 'Claude Code CLI is installed but not signed in.',
    });

    await expect(getDispatchableRuntimeAvailability()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'claude-code',
          available: false,
          unavailableReason: 'needs_auth',
        }),
      ]),
    );
  });

  it('treats a non-empty environment credential as decisive without probing the CLI', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test-key');
    vi.stubEnv('O8_TEST_CLAUDE_MODE', 'logged_out');

    expect(await claudeStatus()).toMatchObject({
      installed: true,
      ready: true,
      authenticated: true,
      unavailableReason: null,
      detail: 'Claude Code CLI is installed and signed in.',
    });
  });

  it('reports ready when the installed CLI confirms the session', async () => {
    vi.stubEnv('O8_TEST_CLAUDE_MODE', 'logged_in');
    writeStaleMarkers();

    expect(await claudeStatus()).toMatchObject({
      installed: true,
      ready: true,
      authenticated: true,
      unavailableReason: null,
      detail: 'Claude Code CLI is installed and signed in.',
    });
  });

  it('returns a bounded structured needs_auth result through the dispatch route when logged out', async () => {
    writeStaleMarkers();
    invalidateRuntimeAuthCache();

    const rejection = await assertRuntimeDispatchable('claude-code').catch((error) => error);
    expect(rejection).toBeInstanceOf(DispatchPreflightError);
    expect(rejection).toMatchObject({
      code: 'dispatch_cli_auth_unavailable',
      status: {
        runtime: 'claude-code',
        house: 'claude',
        installed: true,
        ready: false,
        authenticated: false,
        unavailableReason: 'needs_auth',
      },
    });

    const response = await createMissionRoute.POST(createMissionRequest(91_762_001));
    expect(response.status).toBe(400);
    const body = await response.json() as { ok: boolean; error: { code: string; message: string } };
    expect(body).toMatchObject({ ok: false, error: { code: 'dispatch_cli_auth_unavailable' } });
    expect(body.error.message).toBe(
      'Claude Code CLI is installed but not signed in. Run `claude` once to sign in.',
    );
    expect(body.error.message.length).toBeLessThan(200);
  }, 20_000);

  it.each([
    { mode: 'malformed', label: 'non-JSON output' },
    { mode: 'no_field', label: 'JSON without a loggedIn field' },
    { mode: 'crash', label: 'a non-zero exit' },
  ])('holds an unknown login state open for $label instead of failing closed', async ({ mode }) => {
    vi.stubEnv('O8_TEST_CLAUDE_MODE', mode);
    writeStaleMarkers();

    const status = await claudeStatus();
    expect(status).toMatchObject({
      installed: true,
      ready: true,
      authenticated: false,
      unavailableReason: null,
      detail: 'Claude Code CLI is installed but its sign-in state could not be verified.',
    });
    // Probe output must never reach an operator-facing string.
    expect(`${status.detail} ${status.fix}`).not.toContain(MALFORMED_MARKER);
    expect(status.detail.length).toBeLessThan(200);
    await expect(assertRuntimeDispatchable('claude-code')).resolves.toBeUndefined();
  });

  it('holds an unknown login state open when the probe times out', async () => {
    vi.stubEnv('O8_TEST_CLAUDE_MODE', 'hang');
    writeStaleMarkers();

    const startedAt = Date.now();
    const status = await claudeStatus();
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(status).toMatchObject({
      ready: true,
      authenticated: false,
      unavailableReason: null,
      detail: 'Claude Code CLI is installed but its sign-in state could not be verified.',
    });
  }, 20_000);

  it('falls back to real stored OAuth material when the probe is inconclusive', async () => {
    vi.stubEnv('O8_TEST_CLAUDE_MODE', 'malformed');
    writeStaleMarkers({ claudeAiOauth: { accessToken: 'sk-ant-oat-live', refreshToken: '' } });

    expect(await claudeStatus()).toMatchObject({
      installed: true,
      ready: true,
      authenticated: true,
      unavailableReason: null,
      detail: 'Claude Code CLI is installed and signed in.',
    });
  });

  it('reports not_installed without probing when the CLI is absent', async () => {
    authFixture.installed = false;

    expect(await claudeStatus()).toMatchObject({
      installed: false,
      ready: false,
      authenticated: false,
      unavailableReason: 'not_installed',
      detail: 'Claude Code CLI is not installed.',
    });
  });

  it.each([
    { source: 'openrouter' as const, label: 'OpenRouter gateway' },
    { source: 'codex-subscription' as const, label: 'Codex subscription' },
  ])('keeps a $source-backed worker dispatchable when the native CLI is logged out', async ({ source, label }) => {
    writeStaleMarkers();
    await writeClaudeCodeWorkerProfile({
      source, model: null, codexModel: null, repoSkillAllowlist: [],
    });

    const status = await claudeStatus();
    expect(status).toMatchObject({
      installed: true,
      ready: true,
      authenticated: false,
      unavailableReason: null,
    });
    expect(status.detail).toContain(label);
    await expect(assertRuntimeDispatchable('claude-code')).resolves.toBeUndefined();
    await expect(getDispatchableRuntimeAvailability()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'claude-code', available: true, unavailableReason: null }),
      ]),
    );
  });
});
