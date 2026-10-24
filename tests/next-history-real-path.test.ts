import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { MobileHistoryResponse } from '@/lib/mobile/types';
import { webTree } from '../scripts/next/web-tree';

const host = spawn(process.execPath, ['--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx',
  'scripts/next/dev-server.ts', '--transcript'], { stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, O8_NEXT_API_TOKEN: 'fixture-transcript-bearer', TZ: 'UTC' } });
const lines = createInterface({ input: host.stdout });
let hostError = '';
host.stderr.on('data', chunk => { hostError += String(chunk); });
let origin: string;
beforeAll(async () => {
  origin = await new Promise<string>((resolve, reject) => {
    lines.on('line', line => { try { const data = JSON.parse(line); if (data.origin) resolve(data.origin); } catch {} });
    host.once('exit', () => reject(new Error(`Disposable route host exited before readiness: ${hostError.slice(-1000)}`)));
  });
}, 30000);
afterAll(async () => { lines.close(); if (host.exitCode === null && host.signalCode === null) { const exited = once(host, 'exit'); host.kill('SIGTERM'); await exited; } });
async function read(key: string, before?: string) {
  const query = new URLSearchParams({ sessionKey: key, limit: '100', page: '1', ...(before ? { before } : {}) });
  return fetch(`${origin}/api/mobile/history?${query}`, { headers: { Authorization: 'Bearer fixture-transcript-bearer' } });
}

it('pages all 2,000 persisted rows without overlap through production HTTP history', async () => {
  let before: string | undefined;
  const ids: string[] = [];
  for (let page = 0; page < 20; page++) {
    const response = await read('llm-chat:thoughts-pagination', before);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.page).toMatchObject({ total: 2000, hasMore: page < 19 });
    ids.unshift(...body.transcript.map((entry: { id: string }) => entry.id));
    before = body.page.beforeCursor;
  }
  expect(ids).toEqual(Array.from({ length: 2000 }, (_, index) => `page-${index + 1}`));
  expect((await read('llm-chat:thoughts-pagination', 'invalid-cursor')).status).toBe(409);
});

it('preserves every rich kind from persisted server payloads in the web oracle', async () => {
  const body = await (await read('llm-chat:thoughts-rich')).json() as MobileHistoryResponse;
  const tree = webTree(body.transcript);
  expect(tree.map(row => row.kind)).toEqual(['packet-header', 'message', 'message', 'message', 'message', 'message']);
  expect(JSON.stringify(tree)).toContain('handoff');
  expect(JSON.stringify(tree)).toContain('compaction');
  expect(JSON.stringify(tree)).toContain('table');
  expect(JSON.stringify(tree)).toContain('diff-card');
  expect(JSON.stringify(tree)).toContain('media');
});

it('discovers a persisted runtime worker and reads its actual history beside saved threads', async () => {
  const response = await fetch(`${origin}/api/runtime/inventory?fresh=1`, { headers: { Authorization: 'Bearer fixture-transcript-bearer' } });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.agents).toEqual(expect.arrayContaining([expect.objectContaining({ sessionKey: 'opencode-owned:next-worker' })]));
  const history = await (await read('opencode-owned:next-worker')).json();
  expect(history.transcript.some((entry: { text: string }) => entry.text === 'Worker history reached GPUI.')).toBe(true);
});
