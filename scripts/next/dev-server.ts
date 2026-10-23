/** Disposable route host. Imports the actual two GET handlers; no runtime discovery,
 * background server startup, provider calls, app connections, or app data paths. */
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { NextRequest } from 'next/server';

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'o8-next-dev-'));
  const dataDir = join(root, 'data');
  const repo = join(root, 'fixture-repo');
  mkdirSync(join(dataDir, 'chat-history'), { recursive: true });
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  Object.assign(process.env, { O8_DATA_DIR: dataDir, CORTEX_IDE_DATA_DIR: dataDir, CORTEX_IDE_DB_PATH: join(dataDir, 'fixture.db'), NODE_ENV: 'test' });
  for (const key of ['O8_WORKER_TOKEN', 'O8_API_TOKEN', 'O8_SPECTATOR_TOKEN', 'O8_PACKAGED_APP']) delete process.env[key];
  const seeds = JSON.parse(readFileSync(resolve('native/o8-next/fixtures/sessions.json'), 'utf8')) as Array<{ id: string; title: string; messages: Array<Record<string, unknown>> }>;
  for (const seed of seeds) {
    writeFileSync(join(dataDir, 'chat-history', `${seed.id}.json`), JSON.stringify({ ...seed,
      messages: seed.messages, repoPath: repo, repoName: 'fixture-repo', backend: 'claude', model: 'claude-code',
      savedAt: '2026-10-01T00:00:00.000Z', orchestratorVisible: true }));
  }
  const { GET: sessions } = await import('../../src/app/api/mobile/orchestrator/threads/route');
  const { GET: history } = await import('../../src/app/api/mobile/history/route');
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      requests.push(`${req.method} ${url.pathname}`);
      if (req.method !== 'GET') { res.writeHead(405).end(); return; }
      const route = url.pathname === '/api/mobile/orchestrator/threads' ? sessions : url.pathname === '/api/mobile/history' ? history : null;
      if (!route) { res.writeHead(404).end(); return; }
      // Prevent this development host from becoming a provider-history reader.
      if (route === history && !seeds.some(seed => `llm-chat:${seed.id}` === url.searchParams.get('sessionKey'))) { res.writeHead(404).end(); return; }
      const response = await route(new NextRequest(url, { headers: { host: url.host } }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(500).end('fixture route failed'); }
  });
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    process.stdout.write(`${JSON.stringify({ origin: `http://127.0.0.1:${address.port}` })}\n`);
  });
  function close() {
    server.closeAllConnections(); server.close();
    if (process.env.O8_NEXT_REQUEST_LOG) writeFileSync(process.env.O8_NEXT_REQUEST_LOG, JSON.stringify(requests));
    rmSync(root, { recursive: true, force: true }); process.exit(0);
  }
  process.once('SIGTERM', close); process.once('SIGINT', close);
  setTimeout(close, 120_000).unref();

}
void main().catch(error => { console.error('[o8-next]', error); process.exitCode = 1; });
