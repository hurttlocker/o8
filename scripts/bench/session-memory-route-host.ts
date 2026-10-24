/** CI uses production HTTP handlers without requiring a full application build. */
import { createServer } from 'node:http';
import { NextRequest } from 'next/server';
import { GET as threads } from '../../src/app/api/mobile/orchestrator/threads/route';
import { GET as history } from '../../src/app/api/mobile/history/route';
import { POST as sync } from '../../src/app/api/mobile/sync/route';

const routes = new Map<string, (request: NextRequest) => Promise<Response>>([
  ['/api/mobile/orchestrator/threads', threads],
  ['/api/mobile/history', history],
]);
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
  const handler = request.method === 'POST' && url.pathname === '/api/mobile/sync' ? sync : routes.get(url.pathname);
  if (!handler) {
    response.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
    return;
  }
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const result = await handler(new NextRequest(url, request.method === 'POST'
      ? { method: 'POST', body: Buffer.concat(chunks).toString('utf8') } : undefined));
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
  } catch {
    response.writeHead(500).end();
  }
});
server.listen(Number(process.env.PORT), '127.0.0.1');
