import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';

type Value = Record<string, unknown>;
interface Page { transcript: { id: string; text: string; textOffset: number; nextTextOffset: number | null; textHash: string; originalTextChars: number }[]; nextCursor: string; entryWindowLimit: number }
let root: string;
let store: string;
let child: ChildProcessWithoutNullStreams;
let server: Server;
let request: (method: string, params?: Value) => Promise<Value>;
let stderr = '';
const requests: { method: string; url: string; authorization?: string }[] = [];
const long = Array.from({ length: 2500 }, (_, i) => `Line ${i}: transcript text 🧭\n`).join('');
const escaped = '\u0000"\\\n'.repeat(10_000);
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const save = (text = long) => writeFileSync(store, JSON.stringify([
  { id: 'previous', role: 'user', text: 'Question', timestamp: 0 },
  { id: 'large-entry', role: 'assistant', text, timestamp: 1 },
]));

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-mcp-text-pages-')));
  const data = join(root, 'data'); mkdirSync(data); const repo = join(root, 'repo'); mkdirSync(repo);
  store = join(root, 'transcript.json'); save();
  writeFileSync(join(data, 'ws-token'), 'fixture-transcript-read-token');
  server = createServer((incoming, response) => {
    requests.push({ method: incoming.method ?? '', url: incoming.url ?? '', authorization: incoming.headers.authorization });
    response.setHeader('content-type', 'application/json');
    const url = new URL(incoming.url ?? '/', 'http://fixture');
    if (incoming.method !== 'GET' || url.pathname !== '/api/runtime/transcript') { response.writeHead(404).end('{}'); return; }
    if (url.searchParams.get('sessionKey') !== 'codex-owned:fixture') { response.writeHead(403).end('{"error":"Fixture scope denied"}'); return; }
    const entries = JSON.parse(readFileSync(store, 'utf8')) as Value[];
    const since = url.searchParams.get('sinceId'); const index = since ? entries.findIndex(entry => entry.id === since) : -1;
    const limit = Number(url.searchParams.get('limit') ?? 20);
    response.end(JSON.stringify({ transcript: since ? entries.slice(index + 1, index + 1 + limit) : entries.slice(-limit) }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture API unavailable');
  child = spawn(process.execPath, ['--import', 'tsx', 'src/lib/mcp/cortex-mcp-server.ts'], {
    cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env,
      O8_DATA_DIR: data, CORTEX_IDE_DATA_DIR: data, CORTEX_IDE_DB_PATH: join(data, 'cortex-ide.db'),
      CORTEX_API_BASE: `http://127.0.0.1:${address.port}`, CORTEX_REPO_PATH: repo, CORTEX_THREAD_ID: 'fixture-parent',
      CORTEX_READONLY: '1', O8_MCP_NODE22_CHECKED: '1',
    },
  });
  child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4000); });
  let sequence = 0; let buffer = '';
  const pending = new Map<number, { resolve: (value: Value) => void; reject: (error: Error) => void }>();
  child.stdout.setEncoding('utf8'); child.stdout.on('data', (chunk: string) => {
    buffer += chunk; const lines = buffer.split('\n'); buffer = lines.pop()!;
    for (const line of lines) {
      if (!line.startsWith('{')) continue;
      const result = JSON.parse(line); const job = pending.get(result.id); if (!job) continue;
      pending.delete(result.id);
      if (result.error) job.reject(new Error(JSON.stringify(result.error))); else job.resolve(result.result);
    }
  });
  request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout: ${method}; ${stderr}`)); }, 15_000);
    pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}, 30_000);
afterAll(async () => {
  if (child && child.exitCode === null) { child.stdin.end(); child.kill('SIGKILL'); await once(child, 'exit'); }
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  if (root) rmSync(root, { recursive: true, force: true });
});
const call = (args: Value) => request('tools/call', { name: 'cortex_read_transcript', arguments: { sessionKey: 'codex-owned:fixture', ...args } });
function payload(result: Value): Page {
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  const text = (result.content as { text: string }[])[0].text;
  expect(text.length).toBeLessThanOrEqual(35_000);
  return JSON.parse(text) as Page;
}
async function reconstruct(original: string) {
  save(original);
  let page = payload(await call({ sinceId: 'previous', limit: 1, maxTextChars: 12_000 }));
  const first = page.transcript[0]; expect(first).toBeDefined(); expect(first.textHash).toBe(hash(original));
  let rebuilt = ''; let offset = 0; let reads = 0;
  for (;;) {
    const entry = page.transcript[0]; expect(entry.id).toBe('large-entry'); expect(entry.textOffset).toBe(offset);
    expect(entry.originalTextChars).toBe(original.length); expect(entry.textHash).toBe(first.textHash);
    rebuilt += entry.text;
    if (entry.nextTextOffset === null) break;
    expect(entry.nextTextOffset).toBeGreaterThan(offset); expect(++reads).toBeLessThan(100);
    offset = entry.nextTextOffset;
    page = payload(await call({ entryId: 'large-entry', sinceId: 'previous', textOffset: offset, expectedTextHash: first.textHash, maxTextChars: 12_000 }));
    expect(page.entryWindowLimit).toBe(100); expect(page.nextCursor).toBe('large-entry');
  }
  expect(rebuilt).toBe(original);
}

it('advertises the entry/text cursor arguments through the actual read-only MCP catalog', async () => {
  const listed = await request('tools/list');
  const tool = (listed.tools as { name: string; inputSchema: { properties: Value } }[]).find(tool => tool.name === 'cortex_read_transcript')!;
  for (const field of ['entryId', 'textOffset', 'expectedTextHash']) expect(tool.inputSchema.properties[field]).toBeDefined();
});
it('reconstructs a long persisted entry without losing Unicode or advancing past omitted text', async () => { await reconstruct(long); });
it('makes progress for heavily escaped text while honoring the serialized response budget', async () => { await reconstruct(escaped); });
it('refuses changed text and missing entries without silently returning another entry', async () => {
  save(); const first = payload(await call({ sinceId: 'previous', limit: 1 }));
  const cursor = { entryId: 'large-entry', textOffset: 4000, expectedTextHash: first.transcript[0].textHash };
  save(long + 'changed'); expect((await call(cursor)).isError).toBe(true);
  save(); expect((await call({ entryId: 'missing' })).isError).toBe(true);
  const repeated = await call(cursor); expect(payload(repeated).transcript[0].text).toBe(long.slice(4000, 8000));
  expect(await call(cursor)).toEqual(repeated);
});
it('rejects invalid cursor relationships before a read and preserves upstream scope refusals', async () => {
  const before = requests.length;
  for (const args of [{ textOffset: 1 }, { expectedTextHash: hash(long) }, { entryId: '' },
    { entryId: 'large-entry', textOffset: -1 }, { entryId: 'large-entry', textOffset: 1 },
    { entryId: 'large-entry', expectedTextHash: 'invalid' }]) expect((await call(args)).isError, JSON.stringify(args)).toBe(true);
  expect(requests).toHaveLength(before);
  expect((await call({ entryId: 'large-entry', textOffset: long.length + 1, expectedTextHash: hash(long) })).isError).toBe(true);
  expect((await call({ sessionKey: 'codex-owned:forbidden', entryId: 'large-entry' })).isError).toBe(true);
  expect(requests.every(request => request.method === 'GET' && request.url.startsWith('/api/runtime/transcript?'))).toBe(true);
  expect(requests.every(request => request.authorization === requests[0].authorization)).toBe(true);
  expect(readFileSync(store, 'utf8')).toBe(JSON.stringify([
    { id: 'previous', role: 'user', text: 'Question', timestamp: 0 }, { id: 'large-entry', role: 'assistant', text: long, timestamp: 1 },
  ]));
});
it('counts an escaped cursor again in the complete serialized envelope', async () => {
  const id = '\u0000'.repeat(1000);
  writeFileSync(store, JSON.stringify([{ id, role: 'assistant', text: '\u0000'.repeat(20_000), timestamp: 1 }]));
  try {
    const page = payload(await call({ limit: 1, maxTextChars: 12_000 }));
    expect(page.nextCursor).toBe(id); expect(page.transcript[0].nextTextOffset).toBeGreaterThan(0);
  } finally { save(); }
});
