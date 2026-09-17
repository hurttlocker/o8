/**
 * Local HTTP fixture that mimics the judgment systemone endpoint (#2434,
 * #2436). Replies are queued per test; every request is recorded. `onReply`
 * runs just before a reply is written, so a test can order events against the
 * moment the provider answered.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FixtureReply { status: number; body: unknown; delayMs?: number }
export interface SeenRequest { method?: string; url?: string; authorization?: string; body: Record<string, unknown> }

export interface JudgmentEndpointFixture {
  endpoint: string;
  replies: FixtureReply[];
  seen: SeenRequest[];
  onReply: (() => void) | null;
  reset(): void;
  close(): Promise<void>;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

export async function startJudgmentEndpointFixture(): Promise<JudgmentEndpointFixture> {
  const fixture = {
    endpoint: '',
    replies: [] as FixtureReply[],
    seen: [] as SeenRequest[],
    onReply: null as (() => void) | null,
    reset() {
      fixture.replies.length = 0;
      fixture.seen.length = 0;
      fixture.onReply = null;
    },
    close: async () => {},
  };
  const server: Server = createServer(async (request, response) => {
    const raw = await readBody(request);
    fixture.seen.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      body: JSON.parse(raw) as Record<string, unknown>,
    });
    const reply = fixture.replies.shift() ?? { status: 500, body: { detail: { error_type: 'fixture_exhausted' } } };
    if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
    fixture.onReply?.();
    response.writeHead(reply.status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(reply.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fixture.endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/systemone`;
  fixture.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return fixture;
}
