// @vitest-environment jsdom
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';

const directory = mkdtempSync(join(tmpdir(), 'o8-acp-catalogue-config-'));
vi.stubEnv('O8_DATA_DIR', directory);
vi.stubEnv('CORTEX_IDE_DATA_DIR', directory);
writeFileSync(join(directory, 'ws-token'), 'acp-catalogue-fixture-token-0123456789');
const peer = join(directory, 'peer.cjs');
const log = join(directory, 'protocol.log');
writeFileSync(peer, String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  fs.appendFileSync(process.argv[2], request.method + '\n');
  let result = {};
  if (request.method === 'initialize') result = { protocolVersion: 1 };
  if (request.method === 'session/new') result = { sessionId: 'fixture', configOptions: [
    { id: 'model', type: 'select', currentValue: 'fixture/model', options: [{ value: 'fixture/model', name: 'Fixture model' }] }
  ] };
  if (request.id != null) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
});
setTimeout(() => process.exit(0), 5000).unref();
`);
afterAll(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });
const { GET } = await import('@/app/api/orchestrator/backend-models/route');
const { AcpModelPicker } = await import('@/components/desktop/thoughts/AcpModelPicker');

const error = 'Could not read the agent launch configuration. Check its executable and arguments.';
const request = (backend = 'acp', host = 'localhost') => new NextRequest(`http://localhost/api/orchestrator/backend-models?${new URLSearchParams({ backend, repoPath: directory })}`, { headers: { host } });
let root: Root | undefined;
let host: HTMLDivElement | undefined;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubEnv('O8_ACP_COMMAND', process.execPath);
  vi.stubEnv('O8_ACP_ARGS', '[invalid-settings-marker');
  rmSync(log, { force: true });
  rmSync(join(directory, 'acp-models'), { recursive: true, force: true });
  localStorage.clear();
});
afterEach(async () => {
  await act(async () => root?.unmount()); host?.remove(); root = undefined; host = undefined;
  vi.unstubAllGlobals();
});
async function settled(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(check()).toBe(true);
}

it.each(['[invalid-settings-marker', '[42]', '[null]'])('contains invalid launch arguments through the actual catalogue route (%s)', async args => {
  vi.stubEnv('O8_ACP_ARGS', args);
  const response = await GET(request());
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ backend: 'acp', available: false, groups: [], total: 0, error });
  expect(existsSync(log)).toBe(false);
});

it('contains an invalid executable without echoing its value', async () => {
  vi.stubEnv('O8_ACP_COMMAND', 'invalid-executable-marker\nother'); vi.stubEnv('O8_ACP_ARGS', '[]');
  const response = await GET(request());
  expect(response.status).toBe(503);
  const body = await response.text();
  expect(body).toContain(error); expect(body).not.toContain('invalid-executable-marker');
  expect(existsSync(log)).toBe(false);
});

it('refuses an unauthorized caller before resolving malformed settings', async () => {
  const response = await GET(request('acp', 'untrusted.invalid'));
  expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: 'Unauthorized' });
  expect(existsSync(log)).toBe(false);
});

it('retains unknown-backend refusal before launch resolution', async () => {
  const response = await GET(request('not-a-backend'));
  expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: 'unknown backend' });
  expect(existsSync(log)).toBe(false);
});

it('shows the actionable route error and retries the corrected configuration into a real agent catalogue', async () => {
  const paths: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname !== '/api/orchestrator/backend-models') throw new Error(`Unexpected catalogue request: ${url.pathname}`);
    paths.push(url.search);
    try { return await GET(new NextRequest(url, { headers: { host: 'localhost' } })); }
    catch { return new Response('Internal Server Error', { status: 500 }); }
  }));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const onSelect = vi.fn();
  await act(async () => root!.render(createElement(AcpModelPicker, { backend: 'acp', repoPath: directory, value: null, defaultProvider: 'fixture', onSelect })));
  await settled(() => Boolean(host?.textContent?.includes(error)));
  expect(host.textContent).not.toContain('not installed'); expect(existsSync(log)).toBe(false);
  expect(onSelect).not.toHaveBeenCalled();
  vi.stubEnv('O8_ACP_ARGS', JSON.stringify([peer, log]));
  const retry = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Retry')!;
  expect(retry).toBeDefined(); await act(async () => retry.click());
  await settled(() => Boolean(host?.querySelector('[data-model-choice]')));
  expect(host.textContent).not.toContain(error);
  expect(paths).toHaveLength(2); expect(new URLSearchParams(paths[1]).get('refresh')).toBe('1');
  expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['initialize', 'session/new']);
  const cache = JSON.parse(readFileSync(join(directory, 'acp-models/acp.json'), 'utf8'));
  expect(cache).toMatchObject({ currentModel: 'fixture/model', models: [{ value: 'fixture/model', name: 'Fixture model' }], fingerprint: expect.any(String) });
  await act(async () => host!.querySelector<HTMLButtonElement>('[data-model-choice]')!.click());
  expect(onSelect).toHaveBeenCalledExactlyOnceWith('fixture/model');
});
