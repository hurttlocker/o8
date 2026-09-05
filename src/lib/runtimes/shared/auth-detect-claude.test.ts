import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authFixture = vi.hoisted(() => ({
  home: '',
  claudeBinary: '',
  installed: true,
}));
const symonBridgeFixture = vi.hoisted(() => ({
  selections: [] as Array<{ engine: string; model: string; effort: string } | undefined>,
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    default: { ...actual, homedir: () => authFixture.home },
  };
});

vi.mock('./cli-locate', async (importOriginal) => ({
  ...await importOriginal<typeof import('./cli-locate')>(),
  scanAndLink: vi.fn((binaryName: string) => (
    binaryName === 'claude' && authFixture.installed ? authFixture.claudeBinary : null
  )),
}));

vi.mock('@/lib/mobile/symon-text-bridge-client', () => ({
  readSymonTextPlannerInfo: vi.fn(async (selection?: { engine: string; model: string; effort: string }) => {
    symonBridgeFixture.selections.push(selection);
    return {
      available: true,
      engine: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
      tools: [],
    };
  }),
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
  '  gate) : > "$O8_TEST_CLAUDE_STARTED"; while [ ! -f "$O8_TEST_CLAUDE_RELEASE" ]; do sleep 0.01; done; printf \'%s\\n\' \'{"loggedIn":false}\' ;;',
  '  hang) sleep 20 ;;',
  '  crash) echo "boom" >&2; exit 3 ;;',
  'esac',
  'exit 0',
].join('\n'));
chmodSync(authFixture.claudeBinary, 0o755);

const dataRoot = mkdtempSync(path.join(os.tmpdir(), 'o8-claude-auth-data-'));
const repoPath = path.join(dataRoot, 'repo');
const OPERATOR_TOKEN = 'claude-auth-route-operator-token-0123456789';
execFileSync('git', ['init', '-q', repoPath]);
const priorDataEnv = {
  O8_DATA_DIR: process.env.O8_DATA_DIR,
  CORTEX_IDE_DATA_DIR: process.env.CORTEX_IDE_DATA_DIR,
};
process.env.O8_DATA_DIR = dataRoot;
process.env.CORTEX_IDE_DATA_DIR = dataRoot;
writeFileSync(path.join(dataRoot, 'ws-token'), `${OPERATOR_TOKEN}\n`);

const {
  DispatchPreflightError,
  assertRuntimeDispatchable,
  getDispatchableRuntimeAvailability,
  getRuntimeAuthSnapshot,
  getRuntimeAuthSnapshotForClaudeCarrier,
  invalidateRuntimeAuthCache,
} = await import('./auth-detect');
const { writeClaudeCodeWorkerProfile } = await import('@/lib/claude-code/worker-profile');
const createMissionRoute = await import('@/app/api/orchestrator/create-mission/route');
const claudeCodeProfileRoute = await import('@/app/api/runtime/claude-code-profile/route');
const genUiRoute = await import('@/app/api/mobile/genui/stream/route');
const symonTextSessionRoute = await import('@/app/api/mobile/symon/text-session/route');
const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
type ClaudeCodeModelSource = import('@/lib/claude-code/worker-profile-types').ClaudeCodeModelSource;

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

function createMissionRequest(issueNumber: number, overrides: {
  carrier?: ClaudeCodeModelSource;
  issueRuntime?: 'claude-code';
} = {}): NextRequest {
  return new NextRequest('http://localhost:3001/api/orchestrator/create-mission', {
    method: 'POST',
    headers: { host: 'localhost:3001' },
    body: JSON.stringify({
      clientMutationId: `create-claude-${issueNumber}`,
      repoPath,
      requestedRuntime: 'claude-code',
      ...(overrides.carrier ? { carrier: overrides.carrier } : {}),
      issues: [{
        number: issueNumber,
        title: 'Claude readiness seam',
        body: 'Prove native sign-in verification through mission creation.',
        url: '',
        ...(overrides.issueRuntime ? { runtime: overrides.issueRuntime } : {}),
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
  symonBridgeFixture.selections.length = 0;
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
    { mode: 'malformed', label: 'non-JSON output', issueNumber: 91_762_021 },
    { mode: 'no_field', label: 'JSON without a loggedIn field', issueNumber: 91_762_022 },
    { mode: 'crash', label: 'a non-zero exit', issueNumber: 91_762_023 },
  ])('fails native auth closed for $label without positive credential evidence', async ({ mode, issueNumber }) => {
    vi.stubEnv('O8_TEST_CLAUDE_MODE', mode);
    writeStaleMarkers();
    const before = readOrchestratorControlPlaneState();

    const status = await claudeStatus();
    expect(status).toMatchObject({
      installed: true,
      ready: false,
      authenticated: false,
      unavailableReason: 'needs_auth',
      detail: 'Claude Code CLI is installed but its sign-in state could not be verified.',
    });
    // Probe output must never reach an operator-facing string.
    expect(`${status.detail} ${status.fix}`).not.toContain(MALFORMED_MARKER);
    expect(status.detail.length).toBeLessThan(200);
    await expect(assertRuntimeDispatchable('claude-code')).rejects.toMatchObject({
      code: 'dispatch_cli_auth_unavailable',
    });

    const response = await createMissionRoute.POST(createMissionRequest(issueNumber));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'dispatch_cli_auth_unavailable' },
    });
    const after = readOrchestratorControlPlaneState();
    expect({ missionId: after.missionId, packetIds: after.packets.map((packet) => packet.id) }).toEqual({
      missionId: before.missionId,
      packetIds: before.packets.map((packet) => packet.id),
    });
  });

  it('fails native auth closed without persistence when the probe times out', async () => {
    vi.stubEnv('O8_TEST_CLAUDE_MODE', 'hang');
    writeStaleMarkers();
    const before = readOrchestratorControlPlaneState();

    const startedAt = Date.now();
    const status = await claudeStatus();
    expect(Date.now() - startedAt).toBeLessThan(15_000);
    expect(status).toMatchObject({
      ready: false,
      authenticated: false,
      unavailableReason: 'needs_auth',
      detail: 'Claude Code CLI is installed but its sign-in state could not be verified.',
    });
    const response = await createMissionRoute.POST(createMissionRequest(91_762_024));
    expect(response.status).toBe(400);
    const after = readOrchestratorControlPlaneState();
    expect({ missionId: after.missionId, packetIds: after.packets.map((packet) => packet.id) }).toEqual({
      missionId: before.missionId,
      packetIds: before.packets.map((packet) => packet.id),
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

  it('invalidates the warmed native refusal through the authenticated profile POST route', async () => {
    writeStaleMarkers();
    invalidateRuntimeAuthCache();
    expect((await getRuntimeAuthSnapshot()).statuses.claude).toMatchObject({
      ready: false,
      unavailableReason: 'needs_auth',
    });

    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-profile-cache-test');
    const response = await claudeCodeProfileRoute.POST(new NextRequest(
      'http://localhost:3001/api/runtime/claude-code-profile',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${OPERATOR_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ source: 'openrouter', model: 'provider/test-model', codexModel: null }),
      },
    ));
    const responseJson = await response.json();
    expect(response.status, JSON.stringify(responseJson)).toBe(200);
    expect((await getRuntimeAuthSnapshot()).statuses.claude).toMatchObject({
      ready: true,
      authenticated: false,
      unavailableReason: null,
      detail: expect.stringContaining('OpenRouter gateway'),
    });
  });

  it.each([
    { source: 'openrouter' as const, issueNumber: 91_762_011 },
    { source: 'codex-subscription' as const, issueNumber: 91_762_012 },
  ])('honors a create-mission $source override and persists it on the packet', async ({ source, issueNumber }) => {
    writeStaleMarkers();
    invalidateRuntimeAuthCache();

    const response = await createMissionRoute.POST(createMissionRequest(issueNumber, { carrier: source }));
    expect(response.status).toBe(201);
    const body = await response.json() as {
      ok: boolean;
      result: { packets: Array<{ id: string }> };
    };
    expect(body.ok).toBe(true);
    const packetId = body.result.packets[0]?.id;
    expect(packetId).toBeTruthy();
    expect(readOrchestratorControlPlaneState().packets.find((packet) => packet.id === packetId)).toMatchObject({
      runtime: 'claude-code',
      claudeCodeCarrier: source,
    });
  }, 20_000);

  it.each([
    { source: 'openrouter' as const },
    { source: 'codex-subscription' as const },
  ])('keeps native-only mobile routes unavailable under an unverifiable CLI plus $source profile', async ({ source }) => {
    vi.stubEnv('O8_TEST_CLAUDE_MODE', 'malformed');
    writeStaleMarkers();
    await writeClaudeCodeWorkerProfile({
      source, model: null, codexModel: null, repoSkillAllowlist: [],
    });
    invalidateRuntimeAuthCache();

    expect((await getRuntimeAuthSnapshot()).statuses.claude.ready).toBe(true);
    expect((await getRuntimeAuthSnapshotForClaudeCarrier('native')).statuses.claude).toMatchObject({
      ready: false,
      unavailableReason: 'needs_auth',
    });

    const catalogResponse = await genUiRoute.GET();
    const catalog = await catalogResponse.json() as {
      models: Array<{ id: string; available: boolean }>;
    };
    expect(catalog.models.filter((model) => model.id.startsWith('claude-'))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'claude-sonnet', available: false }),
        expect.objectContaining({ id: 'claude-opus', available: false }),
      ]),
    );

    const symonResponse = await symonTextSessionRoute.POST(new NextRequest(
      'http://localhost:3001/api/mobile/symon/text-session',
      {
        method: 'POST',
        headers: {
          host: 'localhost:3001',
          authorization: `Bearer ${OPERATOR_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ workspaceMode: 'o8', currentRoute: '/mobile/ask', model: 'claude-opus' }),
      },
    ));
    expect(symonResponse.status).toBe(501);
    await expect(symonResponse.json()).resolves.toMatchObject({
      ok: false,
      error: 'no_cli',
    });
    expect(symonBridgeFixture.selections).toEqual([]);
  }, 20_000);

  it('restarts a cold detection after invalidation instead of publishing stale carrier state', async () => {
    const gateDir = mkdtempSync(path.join(authFixture.home, 'claude-probe-gate-'));
    const startedPath = path.join(gateDir, 'started');
    const releasePath = path.join(gateDir, 'release');
    vi.stubEnv('O8_TEST_CLAUDE_MODE', 'gate');
    vi.stubEnv('O8_TEST_CLAUDE_STARTED', startedPath);
    vi.stubEnv('O8_TEST_CLAUDE_RELEASE', releasePath);
    invalidateRuntimeAuthCache();

    const pending = getRuntimeAuthSnapshot();
    await vi.waitFor(() => expect(existsSync(startedPath)).toBe(true));
    await writeClaudeCodeWorkerProfile({
      source: 'openrouter', model: null, codexModel: null, repoSkillAllowlist: [],
    });
    invalidateRuntimeAuthCache();
    writeFileSync(releasePath, 'release');

    await expect(pending).resolves.toMatchObject({
      statuses: {
        claude: {
          ready: true,
          authenticated: false,
          unavailableReason: null,
        },
      },
    });
    expect((await getRuntimeAuthSnapshot()).statuses.claude.detail).toContain('OpenRouter gateway');
    rmSync(gateDir, { recursive: true, force: true });
  }, 20_000);
});
