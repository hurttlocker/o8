import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
const state = vi.hoisted(() => ({ dir: '', denied: false }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => state.dir }));
vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: () => state.denied ? NextResponse.json({}, { status: 401 }) : null }));
import { GET, POST } from './route';
import { resolveLocalAcpLaunch } from '@/lib/acp/local-connection';
state.dir = mkdtempSync(join(tmpdir(), 'o8-acp-connection-'));
const request = (connection: unknown) => new NextRequest('http://localhost/api/runtime/acp-connection', { method: 'POST', body: JSON.stringify({ connection }) });
beforeEach(() => { state.denied = false; vi.stubEnv('O8_ACP_COMMAND', ''); });
afterAll(() => { rmSync(state.dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });
it('persists literal argument boundaries through the route into launch resolution', async () => {
  const connection = { name: 'My agent', command: '/path with spaces/agent', args: ['acp', '--config', '/path with spaces/config.json', '$(not-expanded)'], useOpenRouter: false };
  expect((await POST(request(connection))).status).toBe(200);
  expect(await (await GET(new NextRequest('http://localhost/api/runtime/acp-connection'))).json()).toEqual({ connection, envLocked: false });
  expect(resolveLocalAcpLaunch()).toEqual(connection);
});
it('rejects malformed configuration and preserves environment precedence', async () => {
  expect((await POST(request({ name: 'Bad', command: 'agent\nother', args: [], useOpenRouter: false }))).status).toBe(400);
  vi.stubEnv('O8_ACP_COMMAND', 'env-agent'); vi.stubEnv('O8_ACP_ARGS', '["acp","space preserved"]');
  expect((await POST(request(null))).status).toBe(409);
  expect(resolveLocalAcpLaunch()?.args).toEqual(['acp', 'space preserved']);
});
it('requires panel authorization for reads and writes', async () => {
  state.denied = true;
  expect((await POST(request(null))).status).toBe(401);
  expect((await GET(new NextRequest('http://localhost/api/runtime/acp-connection'))).status).toBe(401);
});
