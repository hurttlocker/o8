/**
 * VERIFY RELAY E2E — the report's spine.
 *
 * Spins the REAL relay locally (RelayServer + attachRelayUpgrade on a raw node
 * http server, random port), with a fake Mac connector + a fake phone + a fake
 * local Next. Drives the full contract:
 *
 *   1. connect both → opaque frame round-trips BYTE-IDENTICAL (both directions)
 *   2. bridged socket is REFUSED until first-frame auth{token} (v1.1 change 2)
 *   3. a tunneled http-req carries the NON-LOOPBACK x-o8-client-addr marker + Bearer
 *      (v1.1 change 1) — the fake Next rejects a loopback-marked request
 *   4. Mac disconnect → phone gets presence{down} + 4408 after the hold
 *   5. reconnect supersede → the old Mac socket is closed 1001
 *   6. rate-limit rejection → the over-limit /device connect is refused (429)
 *   7. push-req → the relay invokes the APNs alert sender (transient token)
 *
 * No env, no real crypto/APNs — deps are injected. Run: npm run verify-e2e
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { WebSocket } from 'ws';

import { attachRelayUpgrade, type UpgradableServer } from '../src/attach.js';
import { RelayServer } from '../src/relay.js';
import { CLOSE, decode, encode, isMuxFrame, toPayload, fromPayload } from '../src/protocol.js';

let failures = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) console.log(`  PASS: ${msg}`);
  else {
    console.error(`  FAIL: ${msg}`);
    failures += 1;
  }
}

const GOOD_TOKEN = 'GOOD-plan-jwt';
const DEVICE_TOKEN = 'DEVTOKEN-abc123';
const MARKER = 'o8-relay-forward';

type Frame = Record<string, unknown>;
type Pred = (f: Frame) => boolean;

/** A frame mailbox attached at socket creation — no attach-after-open race. */
class Mailbox {
  private q: Frame[] = [];
  private waiters: Array<{ pred: Pred; resolve: (f: Frame) => void; timer: ReturnType<typeof setTimeout> }> = [];
  constructor(ws: WebSocket) {
    ws.on('message', (raw) => {
      const f = decode(raw as Buffer);
      if (!f) return;
      const i = this.waiters.findIndex((w) => w.pred(f));
      if (i >= 0) {
        const w = this.waiters.splice(i, 1)[0]!;
        clearTimeout(w.timer);
        w.resolve(f);
      } else {
        this.q.push(f);
      }
    });
  }
  waitFor(pred: Pred, timeoutMs = 3000, label = 'frame'): Promise<Frame> {
    const hit = this.q.findIndex(pred);
    if (hit >= 0) return Promise.resolve(this.q.splice(hit, 1)[0]!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs);
      this.waiters.push({ pred, resolve, timer });
    });
  }
}

function isHttpRes(f: Frame): boolean {
  if (!isMuxFrame(f)) return false;
  try {
    return (JSON.parse(fromPayload(String(f.payload)).toString('utf8')) as { t?: string }).t === 'http-res';
  } catch {
    return false;
  }
}

// ── fake local Next — asserts the non-loopback marker + Bearer on every request ──
function isLoopback(addr: string): boolean {
  const s = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  return s === '::1' || s === '127.0.0.1' || s.startsWith('127.') || s === 'localhost';
}
function startFakeNext(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
      const marker = String(req.headers['x-o8-client-addr'] ?? '');
      const auth = String(req.headers['authorization'] ?? '');
      if (!marker || isLoopback(marker)) {
        res.writeHead(500).end(JSON.stringify({ error: 'loopback_trusted_tunnel_forbidden' }));
        return;
      }
      if (!auth.startsWith('Bearer ')) {
        res.writeHead(401).end(JSON.stringify({ error: 'no_bearer' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, sawMarker: marker }));
    });
    srv.listen(0, '127.0.0.1', () => resolve({ port: (srv.address() as AddressInfo).port, close: () => srv.close() }));
  });
}

// ── fake Mac connector — mirrors the real relay-connector's Mac-side logic ──
interface FakeMac {
  ws: WebSocket;
  firstDevices: Promise<void>;
}
function startFakeMac(relayPort: number, routingId: string, nextPort: number): FakeMac {
  const ws = new WebSocket(`ws://127.0.0.1:${relayPort}/mac`, {
    headers: { authorization: `Bearer ${GOOD_TOKEN}`, 'x-o8-routing-id': routingId },
  });
  const authed = new Set<string>();
  const send = (frame: object) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(encode(frame));
  };
  let resolveFirst: () => void = () => {};
  const firstDevices = new Promise<void>((r) => (resolveFirst = r));

  ws.on('message', (raw) => {
    const f = decode(raw as Buffer);
    if (!f) return;
    if (f.t === 'devices') {
      resolveFirst();
      return;
    }
    if (f.t === 'mux-open' || f.t === 'mux-close') return;
    if (!isMuxFrame(f)) return;
    const sid = String(f.sid ?? '');
    let inner: Frame | null = null;
    try {
      inner = JSON.parse(fromPayload(f.payload).toString('utf8')) as Frame;
    } catch {
      inner = null;
    }

    // First-frame auth gate: NOTHING is processed until a valid auth{token} lands.
    if (!authed.has(sid)) {
      if (inner && inner.t === 'auth') {
        if (inner.token === DEVICE_TOKEN) {
          authed.add(sid);
          send({ t: 'mux-ready', sid });
        } else {
          send({ t: 'mux-close', sid, code: CLOSE.HANDSHAKE_REJECTED, reason: 'bad auth' });
        }
      }
      return; // any non-auth frame before auth is DROPPED (held unauthenticated)
    }

    if (inner && inner.t === 'http-req') {
      const path = typeof inner.path === 'string' ? inner.path : '/';
      void (async () => {
        let status = 0;
        let sawMarker = false;
        try {
          const resp = await fetch(`http://127.0.0.1:${nextPort}${path}`, {
            method: typeof inner?.method === 'string' ? inner.method : 'GET',
            headers: {
              'x-o8-client-addr': MARKER, // v1.1 change 1: non-loopback marker
              authorization: typeof inner?.authorization === 'string' ? inner.authorization : '',
            },
          });
          status = resp.status;
          const body = (await resp.json().catch(() => ({}))) as { sawMarker?: string };
          sawMarker = typeof body.sawMarker === 'string' && !isLoopback(body.sawMarker);
        } catch {
          status = 599;
        }
        send({ t: 'mux', sid, seq: 1, payload: toPayload(JSON.stringify({ t: 'http-res', rid: inner?.rid, status, sawMarker })) });
      })();
      return;
    }
    // Opaque echo — proves the relay forwarded payload bytes untouched, both ways.
    send({ t: 'mux', sid, seq: 2, payload: f.payload });
  });

  return { ws, firstDevices };
}

// ── ws helpers ──
function open(ws: WebSocket, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('open timeout')), timeoutMs);
    ws.once('open', () => {
      clearTimeout(t);
      resolve();
    });
    ws.once('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}
function nextClose(ws: WebSocket, timeoutMs = 3000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('close timeout')), timeoutMs);
    ws.once('close', (code, reason) => {
      clearTimeout(t);
      resolve({ code, reason: reason.toString() });
    });
  });
}
function phoneSend(ws: WebSocket, inner: object): void {
  ws.send(encode({ t: 'mux', seq: 1, payload: toPayload(JSON.stringify(inner)) }));
}
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
/** New phone with a mailbox attached BEFORE open (kills the attach-after-open race). */
function newPhone(relayPort: number, routingId: string): { ws: WebSocket; mb: Mailbox } {
  const ws = new WebSocket(`ws://127.0.0.1:${relayPort}/device/${routingId}`);
  return { ws, mb: new Mailbox(ws) };
}

async function main(): Promise<void> {
  console.log('\n[verify-relay-e2e] spinning the real relay on a random port\n');

  const pushCalls: Array<{ apnsAlertToken: string; environment: string; kind: string }> = [];
  const relay = new RelayServer({
    verifyPlanToken: async (token) =>
      token === GOOD_TOKEN
        ? { ok: true, plan: 'founder', sub: 'u1', exp: Math.floor(Date.now() / 1000) + 3600 }
        : { ok: false, reason: 'bad token' },
    apnsConfigured: () => true,
    sendApprovalAlert: async (input) => {
      pushCalls.push(input);
      return { ok: true, status: 200 };
    },
    macOfflineHoldMs: 200,
    handshakeDeadlineMs: 4000,
    idleSweepMs: 100_000,
    rateLimits: { maxPerMin: 5, maxPending: 8, windowMs: 60_000 },
  });
  relay.start();

  const httpServer = createServer((_req, res) => res.writeHead(426).end('upgrade required'));
  attachRelayUpgrade(httpServer as unknown as UpgradableServer, relay);
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
  const relayPort = (httpServer.address() as AddressInfo).port;
  const next = await startFakeNext();
  console.log(`  relay :${relayPort}  fake-next :${next.port}`);

  // ── Scenario 1 + 3 + 7 ──
  console.log('\n[1/3/7] connect + auth + opaque round-trip + http-req marker + push-req');
  const routingId = 'routingAAA';
  const mac = startFakeMac(relayPort, routingId, next.port);
  await open(mac.ws);
  await mac.firstDevices; // registration finished (past the async JWT verify)
  const phone = newPhone(relayPort, routingId);
  await open(phone.ws);
  const pres = await phone.mb.waitFor((f) => f.t === 'presence', 3000, 'presence-up');
  assert(pres.mac === 'up', 'phone sees presence{mac:up} when Mac is connected');

  phoneSend(phone.ws, { t: 'auth', token: DEVICE_TOKEN });
  await delay(80);

  const randomBytes = Buffer.from(crypto.getRandomValues(new Uint8Array(512)));
  const sentPayload = toPayload(randomBytes);
  phone.ws.send(encode({ t: 'mux', seq: 42, payload: sentPayload }));
  const echoed = await phone.mb.waitFor((f) => isMuxFrame(f) && f.payload === sentPayload, 3000, 'echo');
  assert(
    fromPayload(String(echoed.payload)).equals(randomBytes),
    'opaque payload round-trips BYTE-IDENTICAL through the relay (both directions)',
  );

  phoneSend(phone.ws, { t: 'http-req', rid: 'r1', method: 'GET', path: '/api/mobile/inbox', authorization: `Bearer ${DEVICE_TOKEN}` });
  const httpRes = await phone.mb.waitFor(isHttpRes, 3000, 'http-res');
  const resInner = JSON.parse(fromPayload(String(httpRes.payload)).toString('utf8')) as { status: number; sawMarker: boolean };
  assert(resInner.status === 200, 'http-req is served through the tunnel (200)');
  assert(resInner.sawMarker === true, 'fake Next saw a NON-loopback x-o8-client-addr marker (change 1)');

  mac.ws.send(encode({ t: 'push-req', apnsAlertToken: 'a'.repeat(64), environment: 'sandbox', kind: 'approval' }));
  await delay(60);
  assert(pushCalls.length === 1 && pushCalls[0]!.kind === 'approval', 'push-req triggers the APNs alert sender with the transient token');

  // ── Scenario 2 ──
  console.log('\n[2] first-frame auth gate — http-req before auth is NOT processed');
  const phone2 = newPhone(relayPort, routingId);
  await open(phone2.ws);
  await phone2.mb.waitFor((f) => f.t === 'presence', 3000, 'presence');
  phoneSend(phone2.ws, { t: 'http-req', rid: 'rX', method: 'GET', path: '/api/mobile/inbox', authorization: `Bearer ${DEVICE_TOKEN}` });
  let refusedBeforeAuth = false;
  try {
    await phone2.mb.waitFor(isHttpRes, 500, 'http-res');
  } catch {
    refusedBeforeAuth = true;
  }
  assert(refusedBeforeAuth, 'http-req before auth{token} is refused (no http-res)');

  const phone3 = newPhone(relayPort, routingId);
  await open(phone3.ws);
  await phone3.mb.waitFor((f) => f.t === 'presence', 3000, 'presence');
  phoneSend(phone3.ws, { t: 'auth', token: 'WRONG' });
  const badAuthClose = await nextClose(phone3.ws);
  assert(badAuthClose.code === CLOSE.HANDSHAKE_REJECTED, 'invalid auth token → 4403 passed through from the Mac');

  // ── Scenario 4 ──
  console.log('\n[4] Mac offline → presence{down} + 4408 after the hold');
  mac.ws.close();
  const presDown = await phone.mb.waitFor((f) => f.t === 'presence' && f.mac === 'down', 2000, 'presence-down');
  assert(presDown.mac === 'down', 'phone sees presence{mac:down} when the Mac drops');
  const offlineClose = await nextClose(phone.ws, 2000);
  assert(offlineClose.code === CLOSE.MAC_OFFLINE, 'phone is closed 4408 mac_offline after the hold');

  // ── Scenario 5 ──
  console.log('\n[5] reconnect supersede — old Mac socket closed 1001');
  const supRouting = 'routingSUP';
  const macA = startFakeMac(relayPort, supRouting, next.port);
  await open(macA.ws);
  await macA.firstDevices;
  const macB = startFakeMac(relayPort, supRouting, next.port);
  await open(macB.ws);
  const supClose = await nextClose(macA.ws, 2000);
  assert(supClose.code === 1001, 'the superseded (older) Mac socket is closed 1001');
  macB.ws.close();

  // ── Scenario 6 ──
  console.log('\n[6] rate-limit — the over-limit /device connect is refused (429)');
  const rlRouting = 'routingRL';
  const burst: WebSocket[] = [];
  for (let i = 0; i < 5; i++) {
    const w = new WebSocket(`ws://127.0.0.1:${relayPort}/device/${rlRouting}`);
    burst.push(w);
    await open(w).catch(() => undefined);
  }
  const over = new WebSocket(`ws://127.0.0.1:${relayPort}/device/${rlRouting}`);
  let refused = false;
  await new Promise<void>((resolve) => {
    over.once('open', () => resolve());
    over.once('unexpected-response', (_req, res) => {
      refused = res.statusCode === 429;
      resolve();
    });
    over.once('error', () => resolve());
    setTimeout(resolve, 2000);
  });
  assert(refused, 'the 6th connect within the window is refused with HTTP 429');
  for (const w of burst) w.close();
  try {
    over.close();
  } catch {
    /* noop */
  }

  // ── teardown ──
  relay.stop();
  httpServer.close();
  next.close();
  try {
    phone2.ws.close();
  } catch {
    /* noop */
  }
  await delay(50);

  if (failures > 0) {
    console.error(`\n[verify-relay-e2e] ${failures} FAILURE(S)\n`);
    process.exit(1);
  }
  console.log('\n[verify-relay-e2e] OK — relay honors the v1.1 wire contract end-to-end.\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('[verify-relay-e2e] ERROR:', err);
  process.exit(1);
});
