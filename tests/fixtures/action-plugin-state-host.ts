import { createServer } from 'node:http';
import { NextRequest } from 'next/server';
import { GET, POST } from '../../src/app/api/customize/actions/route';

const server = createServer(async (incoming, outgoing) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const request = new NextRequest(`http://127.0.0.1${incoming.url}`, {
      method: incoming.method,
      headers: { host: '127.0.0.1', 'content-type': 'application/json' },
      ...(incoming.method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
    });
    const response = incoming.method === 'POST' ? await POST(request) : await GET(request);
    outgoing.writeHead(response.status, { 'content-type': 'application/json' });
    outgoing.end(await response.text());
  } catch (error) {
    outgoing.writeHead(500); outgoing.end(String(error));
  }
});
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port.');
  process.stdout.write(`${JSON.stringify({ port: address.port })}\n`);
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
