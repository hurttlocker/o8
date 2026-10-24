import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { compareMcpExchanges, sendRecordedMcp, type RecordedMcpRequest } from '../scripts/lib/mcp-parity';

// Real middleware, MCP host, project route, SQLite and Rust processes. No provider calls.
vi.mock('@clerk/nextjs/server', () => ({ clerkMiddleware: (handler: unknown) => handler }));
const directory = process.env.CORTEX_IDE_DATA_DIR!;
const token = 'stateless-mcp-fixture-credential';
writeFileSync(join(directory, 'ws-token'), token);
process.env.O8D_MCP_READS = '1';
const { panelGateMiddleware } = await import('@/middleware');
const mcp = await import('@/app/api/mcp/route');
const projects = await import('@/app/api/panel/projects/route');
const { closeDb } = await import('@/lib/db');
let base = '';
const candidates: string[] = [];
const children: ChildProcess[] = [];
const server = createServer(async (incoming, outgoing) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const request = new NextRequest(`${base}${incoming.url}`, { method: incoming.method,
      headers: incoming.headers as Record<string, string>, ...(body.length ? { body } : {}) });
    const gate = panelGateMiddleware(request);
    const response = gate.status !== 200 ? gate : request.nextUrl.pathname === '/api/mcp'
      ? await mcp.POST(request) : request.nextUrl.pathname === '/api/panel/projects'
        ? await projects.GET() : new Response(null, { status: 404 });
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch { outgoing.writeHead(500).end(); }
});
beforeAll(async () => {
  await promisify(execFile)('cargo', ['build', '--locked', '--manifest-path', 'crates/o8d/Cargo.toml', '--features', 'experimental-mcp']);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.O8_API_PORT = String((server.address() as { port: number }).port);
  process.env.NEXT_ORIGIN = base;
  for (const native of [false, true]) {
    const child = spawn('crates/o8d/target/debug/o8d-mcp', ['--experimental-mcp', '--listen', '127.0.0.1:0', '--upstream', base,
      ...(native ? ['--native-reads', '--data-dir', directory] : [])], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    const [line] = await Promise.race([once(child.stdout!, 'data'), once(child, 'exit').then(() => { throw new Error('Rust fixture startup failed'); })]);
    candidates.push(`http://${JSON.parse(String(line)).listening}`);
  }
}, 120000);
afterAll(async () => {
  await Promise.all(children.map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit'); child.kill(); await exited;
  }));
  server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
});
const records: Array<RecordedMcpRequest & { expectedStatus: number }> = JSON.parse(readFileSync('tests/fixtures/mcp-parity/stateless.json', 'utf8'));
it.each(records)('preserves $name through both Rust transport modes', async (recording) => {
  const reference = await sendRecordedMcp(base, token, recording);
  expect(reference.status).toBe(recording.expectedStatus);
  if (reference.status === 200 && recording.headers?.['MCP-Protocol-Version'] === '2026-07-28') {
    expect((reference.body as { result: { resultType: string } }).result.resultType).toBe('complete');
  }
  for (const candidate of candidates) compareMcpExchanges(reference, await sendRecordedMcp(candidate, token, recording));
});
