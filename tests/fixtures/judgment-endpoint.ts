/**
 * Local HTTP fixture that mimics the judgment systemone endpoint (#2434,
 * #2435, #2436). Replies are queued per test; every request is recorded.
 * `onReply` runs just before a reply is written, so a test can order events
 * against the moment the provider answered. A reply can wait on `hold` so a
 * test can observe state before the provider answers.
 */
import { chmodSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export const JUDGMENT_FIXTURE_KEY = 'ts-fixture-key-7d1c0b5e9a';

export interface FixtureReply {
  status: number;
  body: unknown;
  delayMs?: number;
  /** The response is not sent until this settles. */
  hold?: Promise<void>;
}
export interface SeenRequest { method?: string; url?: string; authorization?: string; body: Record<string, unknown> }

export type JudgmentFixtureReply = FixtureReply;
export type JudgmentFixtureRequest = SeenRequest;

export interface JudgmentEndpointFixture {
  endpoint: string;
  replies: FixtureReply[];
  seen: SeenRequest[];
  onReply: (() => void) | null;
  /** Responses written since the last reset. */
  responded(): number;
  /** Clear queued replies, recorded requests, the reply hook, and the response count. */
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
  let responded = 0;
  const fixture = {
    endpoint: '',
    replies: [] as FixtureReply[],
    seen: [] as SeenRequest[],
    onReply: null as (() => void) | null,
    responded: () => responded,
    reset() {
      fixture.replies.length = 0;
      fixture.seen.length = 0;
      fixture.onReply = null;
      responded = 0;
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
    if (reply.hold) await reply.hold;
    if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
    fixture.onReply?.();
    responded += 1;
    response.writeHead(reply.status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(reply.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fixture.endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/systemone`;
  fixture.close = () => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  return fixture;
}

/** Write the fixture key where the judgment client reads it (0600). */
export function writeJudgmentFixtureKey(keyPath: string, key: string = JUDGMENT_FIXTURE_KEY): void {
  writeFileSync(keyPath, `${key}\n`);
  chmodSync(keyPath, 0o600);
}
