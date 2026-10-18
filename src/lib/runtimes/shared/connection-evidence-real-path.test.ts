import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ home: '', binary: '' }));
vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, default: { ...actual, homedir: () => fixture.home } };
});
vi.mock('./cli-locate', async importOriginal => ({
  ...await importOriginal<typeof import('./cli-locate')>(),
  scanAndLink: (name: string) => name === 'codex' ? fixture.binary : null,
}));
vi.mock('@/lib/runtimes/shared/antigravity-login-probe', () => ({
  probeAntigravityLogin: async () => ({ installed: false, authenticated: false, detail: 'Not installed', fix: 'Install' }),
}));

fixture.home = mkdtempSync(path.join(os.tmpdir(), 'o8-connection-evidence-'));
fixture.binary = path.join(fixture.home, 'codex');
mkdirSync(path.join(fixture.home, '.codex'));
vi.stubEnv('O8_DATA_DIR', path.join(fixture.home, 'data'));
vi.stubEnv('CORTEX_IDE_DATA_DIR', path.join(fixture.home, 'data'));
vi.stubEnv('OPENAI_API_KEY', '');
vi.stubEnv('CODEX_ACCESS_TOKEN', '');
vi.stubEnv('O8_API_PORT', '41234');
const { invalidateRuntimeAuthCache } = await import('./auth-detect');
const route = await import('@/app/api/panel/operator-defaults/route');
const { runStatus } = await import('../../../../cli/src/commands/status');
const { handleStatus } = await import('@/lib/mcp/operator-handlers/status');
const { setApiBase } = await import('@/lib/mcp/operator-handlers/shared');
setApiBase('http://127.0.0.1:41234');

function cliAnswer(output: string, exit = 0) {
  writeFileSync(fixture.binary, `#!/bin/sh\nprintf '%s\\n' '${output}'${exit ? ' >&2' : ''}\nexit ${exit}\n`);
  chmodSync(fixture.binary, 0o755);
  invalidateRuntimeAuthCache();
}
async function status() {
  const response = await route.GET(new Request('http://localhost/api/panel/operator-defaults'));
  expect(response.status).toBe(200);
  return response.json();
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(() => { vi.unstubAllEnvs(); rmSync(fixture.home, { recursive: true, force: true }); });

it.skipIf(process.platform === 'win32')('keeps an empty CLI response indeterminate through the real protected status read model', async () => {
  cliAnswer('');
  // Historical session metadata is not credential evidence.
  writeFileSync(path.join(fixture.home, '.codex', 'auth.json'), '{}');
  const payload = await status();
  const runtime = payload.dispatchableRuntimes.find((row: { id: string }) => row.id === 'codex');
  expect(runtime.available).toBe(false);
  expect(runtime.connection).toMatchObject({ state: 'indeterminate', providers: [], account: 'not_reported', externalTools: 'not_inspected' });
  expect(runtime.connection.checkedAt).toBeGreaterThan(0);
  expect(runtime.connection.observations).toContainEqual({ source: 'cli_report', outcome: 'unknown' });
});

it.skipIf(process.platform === 'win32')('reports source and check time without forwarding credential contents, with the same CLI and MCP data', async () => {
  cliAnswer('Logged in');
  writeFileSync(path.join(fixture.home, '.codex', 'auth.json'), JSON.stringify({ tokens: { access_token: 'private-fixture-token' } }));
  const payload = await status();
  const runtime = payload.dispatchableRuntimes.find((row: { id: string }) => row.id === 'codex');
  expect(runtime.connection).toMatchObject({ state: 'observed', providers: ['OpenAI'] });
  expect(runtime.connection.observations).toEqual(expect.arrayContaining([
    { source: 'cli_report', outcome: 'present' }, { source: 'credential_file', outcome: 'present' },
  ]));
  const fetcher = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/api/panel/operator-defaults')) return Response.json(payload);
    if (url.includes('/api/lanes')) return Response.json({ lanes: [] });
    if (url.includes('/api/panel/approvals')) return Response.json({ approvals: [] });
    if (url.includes('/api/operator/status')) return Response.json({ agents: [], approvals: [] });
    return Response.json({});
  });
  vi.stubGlobal('fetch', fetcher);
  const writes: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => { writes.push(String(chunk)); return true; }) as typeof process.stdout.write);
  await runStatus({ human: false, verbose: false });
  const cli = JSON.parse(writes.join(''));
  const mcpResult = await handleStatus({});
  const mcpText = mcpResult.content[0];
  if (mcpText.type !== 'text') throw new Error('Expected status text');
  const mcp = JSON.parse(mcpText.text);
  expect(cli.runtimeConnections.status).toBe('available');
  expect(cli.runtimeConnections).toEqual(mcp.data.runtimeConnections);
  expect(cli.runtimeConnections.runtimes.find((row: { id: string }) => row.id === 'codex').connection).toEqual(runtime.connection);
  expect(JSON.stringify(cli.runtimeConnections)).not.toMatch(/private-fixture-token|access_token|binaryPath|values|sources/);
});

it.skipIf(process.platform === 'win32')('retains the CLI signed-out answer when login status writes stderr and exits one', async () => {
  cliAnswer('Not logged in', 1);
  writeFileSync(path.join(fixture.home, '.codex', 'auth.json'), '{}');
  const payload = await status();
  const runtime = payload.dispatchableRuntimes.find((row: { id: string }) => row.id === 'codex');
  expect(runtime.available).toBe(false);
  expect(runtime.connection).toMatchObject({ state: 'not_connected', providers: [] });
  expect(runtime.connection.observations).toContainEqual({ source: 'cli_report', outcome: 'absent' });
});
