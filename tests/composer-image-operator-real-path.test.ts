import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@clerk/nextjs/server', () => ({ clerkMiddleware: (handler: unknown) => handler }));
const directory = mkdtempSync(join(tmpdir(), 'o8-composer-operator-'));
const token = 'fixture-operator-credential-0123456789';
const worker = 'fixture-worker-credential-0123456789';
writeFileSync(join(directory, 'ws-token'), token);
writeFileSync(join(directory, 'worker-token'), worker);
const socketPath = join(directory, 'app.sock');
writeFileSync(`${socketPath}.token`, 'fixture-native-auth');
vi.stubEnv('CORTEX_IDE_DATA_DIR', directory);
vi.stubEnv('O8_DATA_DIR', directory);
vi.stubEnv('O8_TAURI_MCP_SOCKET', socketPath);
vi.stubEnv('TAURI_MCP_AUTH_TOKEN', 'fixture-native-auth');
const { panelGateMiddleware } = await import('@/middleware');
const { POST } = await import('@/app/api/mcp/route');
const { closeDb } = await import('@/lib/db');
const sockets = new Set<Socket>();
let mutations = 0;
let drop = false;
const requestId = 'fixture-request-0001';
const receipts = new Map<string, Record<string, unknown>>();
let wrongMode = false;
const bridge = {
  inspect: (options: { allow_background: boolean }) => ({ status: 'ready', composer_id: 'fixture-composer', allow_background: options.allow_background, document_visibility: options.allow_background ? 'hidden' : 'visible' }),
  attach: (args: Record<string, unknown>) => {
    mutations++; const receipt = { status: 'pending', request_id: args.request_id, composer_id: args.composer_id, allow_background: args.allow_background === true, document_visibility: args.allow_background ? 'hidden' : 'visible' };
    receipts.set(String(args.request_id), receipt); return wrongMode ? { ...receipt, allow_background: !receipt.allow_background } : receipt;
  },
  status: (id: string) => ({ ...receipts.get(id), status: 'completed' }),
};
const server = createServer(socket => {
  sockets.add(socket);
  let buffer = '';
  socket.on('data', chunk => {
    buffer += chunk.toString();
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const request = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
      expect(request.authToken).toBe('fixture-native-auth');
      expect(request.command).toBe('execute_js');
      expect(request.payload.window_label).toBe('main');
      const result = runInNewContext(request.payload.code, { window: { __o8ComposerImages__: bridge } });
      if (drop) { socket.destroy(); return; }
      socket.write(JSON.stringify({ id: request.id, success: true, data: { result } }) + '\n');
    }
  });
});
beforeAll(async () => { await new Promise<void>(resolve => server.listen(socketPath, resolve)); });
afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>(resolve => server.close(() => resolve()));
  closeDb(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true });
});
async function rpc(method: string, params?: Record<string, unknown>, bearer = token) {
  const request = new NextRequest('http://127.0.0.1/api/mcp', {
    method: 'POST', headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }),
  });
  const gate = panelGateMiddleware(request);
  if (gate.status !== 200) return { denied: gate.status };
  const response = await POST(request);
  return response.json();
}
const args = () => ({
  composer_id: 'fixture-composer', request_id: crypto.randomUUID(), filename: 'fixture.png', media_type: 'image/png',
  data_base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
});
describe('operator HTTP catalog/auth -> actual client authenticated socket image calls', () => {
  it('refuses anonymous and worker principals before host/client mutation', async () => {
    for (const bearer of ['', worker, 'invalid-credential']) {
      for (const allow_background of [false, true]) expect(await rpc('tools/call', { name: 'o8_view_attach_image', arguments: { ...args(), allow_background } }, bearer)).toHaveProperty('denied');
    }
    expect(mutations).toBe(0);
  });
  it.each([false, true])('discovers and round-trips mode=%s receipts through the public entry', async allow_background => {
    const list = await rpc('tools/list');
    expect(list.result.tools.map((tool: { name: string }) => tool.name)).toContain('o8_view_attach_image');
    const inspection = await rpc('tools/call', { name: 'o8_view_inspect_composer', arguments: { allow_background } });
    expect(JSON.parse(inspection.result.content[0].text).composer_id).toBe('fixture-composer');
    const payload = { ...args(), allow_background };
    const attached = await rpc('tools/call', { name: 'o8_view_attach_image', arguments: payload });
    expect(JSON.parse(attached.result.content[0].text)).toMatchObject({ status: 'pending', request_id: payload.request_id });
    const status = await rpc('tools/call', { name: 'o8_view_image_attachment_status', arguments: { request_id: payload.request_id } });
    expect(JSON.parse(status.result.content[0].text)).toMatchObject({ status: 'completed', request_id: payload.request_id, allow_background, document_visibility: allow_background ? 'hidden' : 'visible' });
  });
  it('refuses a mismatched mode acknowledgement without replaying the mutation', async () => {
    const before = mutations; wrongMode = true; const payload = { ...args(), allow_background: true };
    const result = await rpc('tools/call', { name: 'o8_view_attach_image', arguments: payload });
    expect(JSON.parse(result.result.content[0].text)).toMatchObject({ code: 'outcome_unknown', allow_background: true });
    wrongMode = false; expect(mutations).toBe(before + 1);
    const status = await rpc('tools/call', { name: 'o8_view_image_attachment_status', arguments: { request_id: payload.request_id } });
    expect(JSON.parse(status.result.content[0].text)).toMatchObject({ status: 'completed', allow_background: true });
    expect(mutations).toBe(before + 1);
  });
  it.each([false, true])('never replays mode=%s attachment after an authenticated write loses its response', async allow_background => {
    const before = mutations; drop = true;
    const payload = { ...args(), allow_background };
    const result = await rpc('tools/call', { name: 'o8_view_attach_image', arguments: payload });
    expect(JSON.parse(result.result.content[0].text)).toMatchObject({ code: 'outcome_unknown', request_id: payload.request_id, composer_id: payload.composer_id });
    expect(result.result.isError).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(mutations).toBe(before + 1);
  });
});
