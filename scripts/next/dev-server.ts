/** Disposable route host. Imports production handlers; no runtime discovery,
 * background server startup, provider calls, app connections, or app data paths. */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { NextRequest } from 'next/server';
import { attachReplaySocket } from './replay-socket';

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'o8-next-dev-'));
  const dataDir = join(root, 'data');
  const repo = join(root, 'fixture-repo');
  mkdirSync(join(dataDir, 'chat-history'), { recursive: true });
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  Object.assign(process.env, { O8_DATA_DIR: dataDir, CORTEX_IDE_DATA_DIR: dataDir, CORTEX_IDE_DB_PATH: join(dataDir, 'fixture.db'), NODE_ENV: 'test', WS_TOKEN: randomBytes(32).toString('hex') });
  for (const key of ['O8_WORKER_TOKEN', 'O8_API_TOKEN', 'O8_SPECTATOR_TOKEN', 'O8_PACKAGED_APP']) delete process.env[key];
  const fixtureToken = process.env.O8_NEXT_API_TOKEN || randomBytes(32).toString('hex');
  writeFileSync(join(dataDir, 'ws-token'), fixtureToken, { mode: 0o600 });
  delete process.env.WS_TOKEN;
  // Bind publication before imports: publisher captures its origin at load time.
  const realtime = createServer((req, res) => {
    req.resume(); res.writeHead(req.url === '/internal/realtime' && req.method === 'POST' ? 204 : 404).end();
  });
  await new Promise<void>(resolveReady => realtime.listen(0, '127.0.0.1', resolveReady));
  const realtimeAddress = realtime.address();
  if (!realtimeAddress || typeof realtimeAddress === 'string') throw new Error('Missing publication fixture port');
  process.env.CORTEX_REALTIME_INTERNAL_ORIGIN = `http://127.0.0.1:${realtimeAddress.port}`;
  const { ensureV71ComposerQueueSchema } = await import('../../src/lib/db/v71-composer-queue-migration');
  const { getSqlite } = await import('../../src/lib/db');
  ensureV71ComposerQueueSchema(getSqlite());
  // Complete one-time legacy boot repairs against the empty owned store before
  // adding post-boot recordings (their deliberately tight timestamps are valid).
  const { listMobileOrchestratorThreads } = await import('../../src/lib/mobile/orchestrator-thread-history');
  listMobileOrchestratorThreads();
  const seeds = JSON.parse(readFileSync(resolve('native/o8-next/fixtures/sessions.json'), 'utf8')) as Array<{ id: string; title: string; messages: Array<Record<string, unknown>> }>;
  for (const seed of seeds) {
    writeFileSync(join(dataDir, 'chat-history', `${seed.id}.json`), JSON.stringify({ ...seed,
      messages: seed.messages, repoPath: repo, repoName: 'fixture-repo', backend: 'claude', model: 'claude-code',
      savedAt: '2026-10-01T00:00:00.000Z', orchestratorVisible: true }));
  }
  const composer = process.argv.includes('--composer');
  if (composer) {
    for (const id of ['thoughts-composer-first', 'thoughts-composer-second', 'thoughts-composer-legacy']) {
      seeds.push({ id, title: id, messages: [] });
      writeFileSync(join(dataDir, 'chat-history', `${id}.json`), JSON.stringify({
        title: id, repoPath: repo, backend: 'pi', model: id.endsWith('-legacy') ? null : 'pi', orchestratorVisible: true,
        savedAt: '2026-10-01T00:00:00.000Z', messages: [{ id: 'initial', role: 'assistant', content: 'Fixture ready',
          timestamp: 1790812800000, receipt: { permissionMode: 'plan' } }],
      }));
    }
  }
  const { GET: sessions } = await import('../../src/app/api/mobile/orchestrator/threads/route');
  const { GET: history } = await import('../../src/app/api/mobile/history/route');
  const { GET: wsInfo } = await import('../../src/app/api/panel/ws-info/route');
  const { getOrCreateWsToken } = await import('../../src/lib/ws-auth');
  const { GET: context } = await import('../../src/app/api/v2/chat-history/route');
  const { GET: state } = await import('../../src/app/api/orchestrator/state/route');
  const queue = await import('../../src/app/api/orchestrator/composer-queue/route');
  const { panelGateMiddleware } = await import('../../src/middleware');
  // Fixture admission is the same injectable native boundary as the existing
  // composer real-path tests. It never starts a runtime or uses an account.
  if (composer) {
    const { getOrchestratorBackend } = await import('../../src/lib/lane/orchestrator-backends/registry');
    Object.defineProperty(getOrchestratorBackend('pi'), 'liveSteer', { value:
      async (_repo: string, _text: string, options: { beforeAdmit: () => void }) => {
        options.beforeAdmit(); return { accepted: true };
      }, configurable: true });
  }
  const getRoutes: Record<string, (request: NextRequest) => Promise<Response>> = {
    '/api/mobile/orchestrator/threads': sessions, '/api/mobile/history': history,
    '/api/v2/chat-history': context, '/api/orchestrator/state': state,
    '/api/orchestrator/composer-queue': queue.GET, '/api/panel/ws-info': wsInfo,
  };
  const requests: string[] = [];
  let responseLost = false;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      requests.push(`${req.method} ${url.pathname}`);
      const route = req.method === 'GET' ? getRoutes[url.pathname]
        : composer && url.pathname === '/api/orchestrator/composer-queue'
          ? req.method === 'POST' ? queue.POST : req.method === 'PATCH' ? queue.PATCH : null : null;
      if (!route) { res.writeHead(404).end(); return; }
      // Prevent this development host from becoming a provider-history reader.
      if (route === history && !seeds.some(seed => `llm-chat:${seed.id}` === url.searchParams.get('sessionKey'))) { res.writeHead(404).end(); return; }
      if (route === context && !seeds.some(seed => seed.id === url.searchParams.get('tabId'))) { res.writeHead(404).end(); return; }
      let body = '';
      for await (const chunk of req) { body += String(chunk); if (body.length > 1024 * 1024) throw new Error('Fixture body limit'); }
      if (body) {
        const target = JSON.parse(body) as { threadId?: string; repoPath?: string };
        if (!target.threadId?.startsWith('thoughts-composer-') || target.repoPath !== repo) { res.writeHead(400).end(); return; }
      }
      const request = new NextRequest(url, { method: req.method,
        headers: { host: url.host, 'Content-Type': 'application/json', 'x-o8-client-addr': '127.0.0.1',
          ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) }, ...(body ? { body } : {}) });
      const gate = panelGateMiddleware(request);
      const response = gate.status === 200 ? await route(request) : gate;
      // PATCH exercises actual steer admission and its persisted transcript echo.
      if (composer && response.ok && (route === queue.PATCH || (route === queue.POST && JSON.parse(body).intent === 'steer-now'))) {
        const { claimComposerSteer } = await import('../../src/lib/orchestrator/composer-queue');
        const { runQueuedComposerSteer } = await import('../../src/lib/ws-server/composer-queue-heartbeat');
        const item = claimComposerSteer((await response.clone().json()).item.id);
        if (item) await runQueuedComposerSteer(item);
      }
      if (composer && route === queue.POST && response.ok && !responseLost
        && JSON.parse(body).payload?.text === 'Fixture lose response') {
        responseLost = true; res.destroy(); return;
      }
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(500).end('fixture route failed'); }
  });
  const closeSockets = attachReplaySocket(server, getOrCreateWsToken(), requests);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    Object.assign(process.env, { O8_WS_PORT:String(address.port), WS_PORT:String(address.port), O8_API_PORT:String(address.port) });
    writeFileSync(join(dataDir,'ws-port'),String(address.port));
    process.stdout.write(`${JSON.stringify({ origin: `http://127.0.0.1:${address.port}` })}\n`);
  });
  function close() {
    closeSockets();
    server.closeAllConnections(); server.close();
    realtime.closeAllConnections(); realtime.close();
    if (process.env.O8_NEXT_REQUEST_LOG) writeFileSync(process.env.O8_NEXT_REQUEST_LOG, JSON.stringify(requests));
    rmSync(root, { recursive: true, force: true }); process.exit(0);
  }
  process.once('SIGTERM', close); process.once('SIGINT', close);
  setTimeout(close, 120_000).unref();

}
void main().catch(error => { console.error('[o8-next]', error); process.exitCode = 1; });
