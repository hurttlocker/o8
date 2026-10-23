import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { WebSocket } from 'ws';
import { fixtureInbox, startParityReference } from '../../tests/fixtures/ws-parity-server';
import { startRustParity } from '../../tests/fixtures/ws-parity-rust';

type Frame = { channel?: string; event?: string; data?: Record<string, unknown> };
let phase = 'startup';

async function subscriber(url: string, token: string) {
  const endpoint = new URL(url);
  endpoint.searchParams.set('token', token);
  const socket = new WebSocket(endpoint);
  const frames: Frame[] = [];
  socket.on('message', (raw) => frames.push(JSON.parse(String(raw))));
  const wait = async (predicate: (frame: Frame) => boolean) => {
    const deadline = performance.now() + 10_000;
    while (!frames.some(predicate)) {
      if (performance.now() > deadline) throw new Error('benchmark delivery timed out');
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
  await once(socket, 'open');
  await wait((frame) => frame.channel === 'system' && frame.event === 'connected');
  const cursor = frames.find((frame) => frame.channel === 'system' && frame.event === 'connected')?.data?.realtimeSeq;
  if (typeof cursor !== 'number') throw new Error('benchmark welcome missing cursor');
  socket.send(JSON.stringify({ type: 'realtime-negotiate', protocol: { min: 1, max: 1 },
    appVersion: '1.0.0', clientKind: 'test', capabilities: [] }));
  await wait((frame) => frame.channel === 'realtime' && frame.event === 'welcome');
  const epoch = frames.find((frame) => frame.event === 'welcome')?.data?.epoch;
  // This measures live fan-out. Replaying a large log can drop the lossy pong barrier.
  socket.send(JSON.stringify({ type: 'realtime-subscribe', subscriptions: [{ stream: 'global', epoch, since: cursor }] }));
  socket.send(JSON.stringify({ type: 'ping' }));
  await wait((frame) => frame.channel === 'pong');
  frames.length = 0;
  return {
    delivered: (id: string) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.off('message', receive); reject(new Error('benchmark delivery timed out')); }, 10_000);
      function receive(raw: WebSocket.RawData) {
        const frame = JSON.parse(String(raw)) as Frame;
        const events = frame.data?.events as Array<{ data?: { mutation?: { mutationId?: string } } }> | undefined;
        if (!events?.some((event) => event.data?.mutation?.mutationId === id)) return;
        clearTimeout(timer);
        socket.off('message', receive);
        resolve();
      }
      socket.on('message', receive);
    }),
    close: async () => {
      const closed = once(socket, 'close');
      socket.close(1000, 'benchmark complete');
      await closed;
    },
  };
}

function rssMiB(pid: number) {
  const status = readFileSync(`/proc/${pid}/status`, 'utf8');
  const rss = Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1]);
  if (!Number.isFinite(rss)) throw new Error('RSS unavailable');
  return Number((rss / 1024).toFixed(2));
}

async function main() {
  const binary = process.env.O8D_TEST_BINARY;
  if (!binary || process.platform !== 'linux') throw new Error('requires Linux and O8D_TEST_BINARY');
  const directory = mkdtempSync(join(tmpdir(), 'o8-ws-bench-'));
  const initial = join(directory, 'initial.json');
  writeFileSync(initial, JSON.stringify([
    { channel: 'orchestrator-threads', event: 'snapshot', data: { threads: [] } },
    { channel: 'inbox', event: 'update', data: fixtureInbox },
  ]));
  const reference = await startParityReference({ logLimit: 400 });
  let rust: Awaited<ReturnType<typeof startRustParity>> | undefined;
  const results: unknown[] = [];
  try {
    rust = await startRustParity(binary, reference.token, initial);
    let sequence = 0;
    for (const [server, target] of [['typescript', reference], ['rust', rust]] as const) {
      const baselineMiB = rssMiB(target.pid);
      for (const count of [1, 20]) {
        phase = `${server}/${count}/connect`;
        const clients = await Promise.all(Array.from({ length: count }, () => subscriber(target.url, reference.token)));
        await new Promise((resolve) => setTimeout(resolve, 100));
        const idleMiB = rssMiB(target.pid);
        const samples: number[] = [];
        try {
          for (let index = 0; index < 220; index += 1) {
            phase = `${server}/${count}/sample-${index}`;
            const id = `${server}-${count}-${index}`;
            const mutation = { mutationId: id, source: 'server', action: 'parity-benchmark',
              status: 'completed', createdAt: '2026-01-01T00:00:00.000Z', note: 'x'.repeat(1024) };
            const delivered = Promise.all(clients.map((client) => client.delivered(id)));
            const start = performance.now();
            const published = server === 'typescript'
              ? fetch(new URL('/internal/realtime', reference.url.replace(/^ws/, 'http')), {
                method: 'POST', headers: { Authorization: `Bearer ${reference.token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ kind: 'mutation', mutation }),
              }).then(async (response) => {
                await response.arrayBuffer();
                if (response.status !== 202) throw new Error('producer rejected');
              })
              : new Promise<void>((resolve, reject) => rust!.child.stdin!.write(`${JSON.stringify([{
                protocol: 1, seq: ++sequence, stream: 'global', channel: 'mutation', event: 'mutation.settled',
                ts: '2026-01-01T00:00:00.000Z', entityId: id, health: { state: 'live' }, data: { mutation },
              }])}\n`, (error) => error ? reject(error) : resolve()));
            await delivered;
            const elapsed = performance.now() - start;
            await published;
            if (index >= 20) samples.push(elapsed);
          }
        } finally {
          await Promise.all(clients.map((client) => client.close()));
        }
        samples.sort((a, b) => a - b);
        results.push({ server, subscribers: count, samples: samples.length, baselineMiB, idleMiB,
          p50Ms: Number(samples[Math.ceil(samples.length * 0.5) - 1].toFixed(3)),
          p95Ms: Number(samples[Math.ceil(samples.length * 0.95) - 1].toFixed(3)) });
      }
    }
    console.log(JSON.stringify({ results, method: 'Last subscriber receipt; 20 warmups, 200 sequential samples; 1 KiB mutation note. TS HTTP producer vs Rust inherited pipe; per-process baseline and connected idle RSS. Rust still requires TS producers.' }, null, 2));
  } finally {
    await rust?.stop();
    await reference.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : '';
  const safe = /^(benchmark (delivery timed out|welcome missing cursor)|producer rejected|reference WS (health timed out|process exited)|Rust fixture (failed to start|exited before listening)|RSS unavailable|requires Linux and O8D_TEST_BINARY)$/.test(message);
  console.error(`WS benchmark failed at ${phase}: ${safe ? message : 'fixture or transport error'}`);
  process.exitCode = 1;
});
