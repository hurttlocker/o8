import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { exportSPKI, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@clerk/nextjs/server', () => ({ auth: async () => ({ userId: null }) }));

const owner = 'user_device';
let dataDir: string;
let server: Server;
let calls: Array<{ path: string; authorization?: string; body: unknown }>;
let respond: (path: string) => Promise<{ status: number; body: unknown; disconnect?: boolean }>;
let credential: string;
const idleExpiresAt = '2027-01-01T00:00:00.000Z';

function request(action: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
  return new Request(`http://localhost/api/panel/auth/device/${action}`, {
    method: action === 'status' ? 'GET' : 'POST',
    headers: { host: 'localhost', 'x-o8-client-addr': '127.0.0.1', 'Content-Type': 'application/json', ...extraHeaders },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function enroll(clerkUserId = owner) {
  const { POST } = await import('@/app/api/panel/auth/device/enroll/route');
  return POST(request('enroll', { clerkUserId }, { 'x-clerk-session-token': randomBytes(24).toString('hex') }));
}

async function seed() {
  const store = await import('@/lib/auth/device-session-store');
  store.writeDeviceSession({ token: credential, clerkUserId: owner, installId: 'install_device', idleExpiresAt });
  return store;
}

describe('desktop device routes through a fake license server and persisted state', () => {
  beforeEach(async () => {
    vi.resetModules();
    dataDir = mkdtempSync(join(tmpdir(), 'o8-device-session-'));
    vi.stubEnv('CORTEX_IDE_DATA_DIR', dataDir);
    credential = randomBytes(32).toString('hex');
    calls = [];
    respond = async () => ({ status: 200, body: { deviceToken: credential, clerkUserId: owner, idleExpiresAt } });
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString();
      calls.push({ path: req.url!, authorization: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
      const reply = await respond(req.url!);
      if (reply.disconnect) { res.destroy(); return; }
      res.writeHead(reply.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    vi.stubEnv('O8_PROXY_URL', `http://127.0.0.1:${address.port}`);
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('enrolls with native session transport and server-owned install metadata at 0600', async () => {
    const session = randomBytes(24).toString('hex');
    const { POST } = await import('@/app/api/panel/auth/device/enroll/route');
    const response = await POST(request('enroll', { clerkUserId: owner, installId: 'untrusted' }, {
      'x-clerk-session-token': session,
    }));
    expect(await response.json()).toEqual({ ok: true, clerkUserId: owner });
    expect(calls[0]).toMatchObject({ path: '/account/device', authorization: `Bearer ${session}` });
    const persisted = JSON.parse(readFileSync(join(dataDir, 'device-session.json'), 'utf8'));
    expect(persisted).toEqual({ token: credential, clerkUserId: owner, installId: readFileSync(join(dataDir, 'install-id'), 'utf8').trim(), idleExpiresAt });
    expect(calls[0].body).toMatchObject({ installId: persisted.installId, platform: process.platform, appVersion: expect.any(String) });
    expect(statSync(join(dataDir, 'device-session.json')).mode & 0o777).toBe(0o600);
    expect(readdirSync(dataDir).filter((file) => file.includes('.tmp'))).toEqual([]);
  });

  it('reports only presence and owner, never the credential', async () => {
    const { GET } = await import('@/app/api/panel/auth/device/status/route');
    expect(await (await GET(request('status'))).json()).toEqual({ present: false, clerkUserId: null });
    await seed();
    expect(await (await GET(request('status'))).json()).toEqual({ present: true, clerkUserId: owner });
  });

  it.each(['status', 'enroll', 'renew', 'revoke'] as const)('refuses non-loopback %s even with a spoofed Host', async (action) => {
    const routes = {
      status: async () => (await import('@/app/api/panel/auth/device/status/route')).GET,
      enroll: async () => (await import('@/app/api/panel/auth/device/enroll/route')).POST,
      renew: async () => (await import('@/app/api/panel/auth/device/renew/route')).POST,
      revoke: async () => (await import('@/app/api/panel/auth/device/revoke/route')).POST,
    };
    const handler = await routes[action]();
    const response = await handler(request(action, undefined, { 'x-o8-client-addr': '192.0.2.1' }));
    expect(response.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('rejects enrollment without a session or valid owner', async () => {
    const { POST } = await import('@/app/api/panel/auth/device/enroll/route');
    expect((await POST(request('enroll', { clerkUserId: owner }))).status).toBe(401);
    expect((await POST(request('enroll', {}, { 'x-clerk-session-token': credential }))).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('rejects a verified enrollment owner mismatch without persisting', async () => {
    expect((await enroll('user_other')).status).toBe(409);
    expect(existsSync(join(dataDir, 'device-session.json'))).toBe(false);
  });

  it('single-flights renewal, persists rotation, and exposes only the ticket and owner', async () => {
    const store = await seed();
    const rotated = randomBytes(32).toString('hex');
    const ticket = randomBytes(24).toString('hex');
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    respond = async () => { await hold; return { status: 200, body: { ticket, clerkUserId: owner, deviceToken: rotated, idleExpiresAt } }; };
    const { POST } = await import('@/app/api/panel/auth/device/renew/route');
    const first = POST(request('renew'));
    const second = POST(request('renew'));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    release();
    expect(await (await first).json()).toEqual({ ticket, clerkUserId: owner });
    expect(await (await second).json()).toEqual({ ticket, clerkUserId: owner });
    expect(calls[0]).toEqual({ path: '/account/device/renew', authorization: `Bearer ${credential}`, body: { installId: 'install_device' } });
    expect(store.readDeviceSession()?.token).toBe(rotated);
  });

  it.each([401, 403])('deletes a device refused with %s without echoing upstream secrets', async (status) => {
    const store = await seed();
    respond = async () => ({ status, body: { error: credential } });
    const { POST } = await import('@/app/api/panel/auth/device/renew/route');
    const response = await POST(request('renew'));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ ok: false, reason: status === 401 ? 'device_invalid' : 'account_blocked' });
    expect(store.readDeviceSession()).toBeNull();
  });

  it('retires an unconfirmed rotation after three quick retries before backoff', async () => {
    const store = await seed();
    respond = async () => ({ status: 503, body: { error: credential } });
    const { POST } = await import('@/app/api/panel/auth/device/renew/route');
    const response = await POST(request('renew'));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(credential);
    expect(calls.filter((call) => call.path.endsWith('/renew'))).toHaveLength(4);
    expect(store.readDeviceSession()).toBeNull();
  });

  it.each(['lost-response', 'invalid-response', 'failed-write'] as const)('recovers a %s using the previous token within rotation grace', async (failure) => {
    const store = await seed();
    const rotated = randomBytes(32).toString('hex');
    const ticket = randomBytes(24).toString('hex');
    if (failure === 'failed-write') {
      const write = store.writeDeviceSession;
      let failed = false;
      vi.spyOn(store, 'writeDeviceSession').mockImplementation((value) => {
        if (value.token === rotated && !failed) { failed = true; throw new Error('Storage unavailable'); }
        write(value);
      });
    }
    respond = async () => {
      const first = calls.length === 1;
      return { status: 200, disconnect: first && failure === 'lost-response', body:
        first && failure === 'invalid-response' ? {} : { deviceToken: rotated, ticket, clerkUserId: owner, idleExpiresAt } };
    };
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const started = Date.now();
    const { POST } = await import('@/app/api/panel/auth/device/renew/route');
    const response = await POST(request('renew'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ticket, clerkUserId: owner });
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.authorization === `Bearer ${credential}`)).toBe(true);
    expect(timeout.mock.calls.some(([milliseconds]) => milliseconds === 30_000)).toBe(true);
    expect(Date.now() - started).toBeLessThan(60_000);
    expect(store.readDeviceSession()?.token).toBe(rotated);
  });

  it('never replays the previous token after sleeping through the recovery deadline', async () => {
    const store = await seed();
    const started = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(started);
    respond = async () => { now.mockReturnValue(started + 300_001); return { status: 200, body: {}, disconnect: true }; };
    const { POST } = await import('@/app/api/panel/auth/device/renew/route');
    expect((await POST(request('renew'))).status).toBe(503);
    expect(store.readDeviceSession()).toBeNull();
    expect((await POST(request('renew'))).status).toBe(401);
    expect(calls.filter((call) => call.path.endsWith('/renew'))).toHaveLength(1);
  });

  it('retires an uncertain rotation persisted by an earlier process without replaying it', async () => {
    await seed();
    const target = join(dataDir, 'device-session.json');
    const previous = JSON.parse(readFileSync(target, 'utf8'));
    writeFileSync(target, JSON.stringify({ ...previous, renewalStartedAt: Date.now() - 60_001 }));
    vi.resetModules();
    const { POST } = await import('@/app/api/panel/auth/device/renew/route');
    expect((await POST(request('renew'))).status).toBe(401);
    expect(existsSync(target)).toBe(false);
    expect(calls.length).toBe(0);
  });

  it.each(['rollback', 'monotonic-expiry', 'wall-expiry', 'late-success'] as const)('round 2 clock: exhausts recovery on %s without another upstream request', async (scenario) => {
    const store = await seed();
    const wallStart = Date.now();
    const wall = vi.spyOn(Date, 'now').mockReturnValue(wallStart);
    const monotonic = vi.spyOn(performance, 'now').mockReturnValue(1_000);
    respond = async () => {
      wall.mockReturnValue(wallStart + (scenario === 'rollback' ? -1 : scenario === 'wall-expiry' ? 60_001 : 1));
      monotonic.mockReturnValue(scenario === 'monotonic-expiry' || scenario === 'late-success' ? 301_001 : 1_001);
      return { status: 200, disconnect: scenario !== 'late-success', body: {
        deviceToken: randomBytes(32).toString('hex'), ticket: randomBytes(24).toString('hex'), clerkUserId: owner, idleExpiresAt,
      } };
    };
    const { POST } = await import('@/app/api/panel/auth/device/renew/route');
    const response = await POST(request('renew'));
    expect(response.status).toBe(503);
    expect(calls.length).toBe(1);
    expect(store.readDeviceSession()).toBeNull();
    expect(existsSync(join(dataDir, 'device-revoke-pending.json'))).toBe(false);
  });

  it.each([1, -3_600_000, null, 'invalid'])('round 2 clock: never resumes persisted uncertainty %s in another process', async (offset) => {
    await seed();
    const target = join(dataDir, 'device-session.json');
    const record = JSON.parse(readFileSync(target, 'utf8'));
    writeFileSync(target, JSON.stringify({ ...record, renewalStartedAt: typeof offset === 'number' ? Date.now() - offset : offset }));
    vi.resetModules();
    const { POST } = await import('@/app/api/panel/auth/device/renew/route');
    expect((await POST(request('renew'))).status).toBe(401);
    expect(calls.length).toBe(0);
    expect(existsSync(target)).toBe(false);
  });

  it.each(['renew', 'revoke'] as const)('round 2 uncertainty: %s only deletes an uncertain device and never revokes it', async (action) => {
    const store = await seed();
    store.writeDeviceSession({ ...store.readDeviceSession()!, renewalStartedAt: Date.now() - 600_000 });
    const route = action === 'renew'
      ? await import('@/app/api/panel/auth/device/renew/route') : await import('@/app/api/panel/auth/device/revoke/route');
    await route.POST(request(action));
    expect(store.readDeviceSession()).toBeNull();
    expect(calls.length).toBe(0);
    expect(existsSync(join(dataDir, 'device-revoke-pending.json'))).toBe(false);
  });

  it('round 2 uncertainty: exhausting live recovery does not queue or send a revoke', async () => {
    const store = await seed();
    respond = async () => ({ status: 503, body: {} });
    const { POST } = await import('@/app/api/panel/auth/device/renew/route');
    expect((await POST(request('renew'))).status).toBe(503);
    expect(calls.map((call) => call.path)).toEqual(Array(4).fill('/account/device/renew'));
    expect(store.readDeviceSession()).toBeNull();
    expect(store.readPendingDeviceRevokes()).toEqual([]);
  });

  it.each(['status', 'revoke'] as const)('round 2 corruption: quarantines invalid pending JSON through %s with a content-free warning', async (action) => {
    const store = await seed();
    const target = join(dataDir, 'device-revoke-pending.json');
    writeFileSync(target, `{${credential}`);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const response = action === 'status'
      ? await (await import('@/app/api/panel/auth/device/status/route')).GET(request(action))
      : await (await import('@/app/api/panel/auth/device/revoke/route')).POST(request(action));
    expect(response.status).toBe(200);
    expect(existsSync(target)).toBe(false);
    expect(warning.mock.calls).toEqual([['[auth] discarded invalid pending device revocation state']]);
    expect(calls.length).toBe(action === 'status' ? 0 : 1);
    if (action === 'revoke') expect(store.readDeviceSession()).toBeNull();
    vi.resetModules();
    const { GET } = await import('@/app/api/panel/auth/device/status/route');
    expect((await GET(request('status'))).status).toBe(200);
  });

  it('round 2 corruption: attempts direct revoke when persisting a current token fails', async () => {
    const store = await seed();
    vi.spyOn(store, 'queueDeviceRevoke').mockImplementation(() => { throw new Error('Storage unavailable'); });
    const { POST } = await import('@/app/api/panel/auth/device/revoke/route');
    const response = await POST(request('revoke'));
    expect(response.status).toBe(200);
    expect(calls.length).toBe(1);
    expect(calls[0].path).toBe('/account/device/revoke');
    expect(calls[0].authorization === `Bearer ${credential}`).toBe(true);
    expect(store.readDeviceSession()).toBeNull();
  });

  it.each(['signed-out', 'persisted', 'exhausted'] as const)('round 2 cleanup: deletes an uncertain token despite pending cleanup failure in %s renewal', async (mode) => {
    const store = await seed();
    if (mode !== 'exhausted') store.writeDeviceSession({ ...store.readDeviceSession()!, renewalStartedAt: Date.now() });
    if (mode === 'signed-out') (await import('@/lib/auth/sign-out-marker')).markAuthSignedOut();
    vi.spyOn(store, 'removePendingDeviceRevoke').mockImplementation(() => { throw new Error('Storage unavailable'); });
    respond = async () => ({ status: 503, body: {} });
    const { POST } = await import('@/app/api/panel/auth/device/renew/route');
    expect((await POST(request('renew'))).status).toBe(503);
    expect(store.readDeviceSession()).toBeNull();
    expect(calls.filter((call) => call.path.endsWith('/revoke')).length).toBe(0);
    expect(calls.length).toBe(mode === 'exhausted' ? 4 : 0);
  });

  it('round 2 uncertainty: discards legacy queue entries whose rotation status cannot be proven', async () => {
    const target = join(dataDir, 'device-revoke-pending.json');
    writeFileSync(target, JSON.stringify([credential]));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { GET } = await import('@/app/api/panel/auth/device/status/route');
    expect((await GET(request('status'))).status).toBe(200);
    expect(calls.length).toBe(0);
    expect(existsSync(target)).toBe(false);
  });

  it('round 2 bounds: retains only the newest sixteen current pending revokes', async () => {
    const store = await seed();
    const tokens = Array.from({ length: 20 }, () => randomBytes(32).toString('hex'));
    tokens.forEach((token) => store.queueDeviceRevoke(token));
    respond = async () => ({ status: 503, body: {} });
    const { GET } = await import('@/app/api/panel/auth/device/status/route');
    expect((await GET(request('status'))).status).toBe(200);
    expect(calls.length).toBe(16);
    expect(store.readPendingDeviceRevokes()).toEqual(tokens.slice(-16));
    expect(statSync(join(dataDir, 'device-revoke-pending.json')).mode & 0o777).toBe(0o600);
  });

  it('round 2 bounds: starts pending revokes in parallel so one slow attempt does not serialize the queue', async () => {
    const store = await seed();
    Array.from({ length: 3 }, () => randomBytes(32).toString('hex')).forEach((token) => store.queueDeviceRevoke(token));
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    respond = async () => { await hold; return { status: 200, body: {} }; };
    const { GET } = await import('@/app/api/panel/auth/device/status/route');
    const pending = GET(request('status'));
    try {
      await vi.waitFor(() => expect(calls.length).toBe(3));
    } finally {
      release();
      await pending;
    }
    expect(store.readPendingDeviceRevokes()).toEqual([]);
  });

  it('deletes the superseded token when only the sign-in epoch changes during rotation', async () => {
    const store = await seed();
    const rotated = randomBytes(32).toString('hex');
    const managed = await import('@/lib/github-broker/managed');
    respond = async (path) => {
      if (path.endsWith('/renew')) managed.bumpSignInEpoch();
      return { status: 200, body: { deviceToken: rotated, ticket: randomBytes(24).toString('hex'), clerkUserId: owner, idleExpiresAt } };
    };
    const { POST } = await import('@/app/api/panel/auth/device/renew/route');
    expect((await POST(request('renew'))).status).toBe(409);
    expect(store.readDeviceSession()).toBeNull();
    expect(calls[1]).toMatchObject({ path: '/account/device/revoke', authorization: `Bearer ${rotated}` });
  });

  it('persists abandoned-rotation revocation before removing the old credential', async () => {
    const store = await seed();
    const rotated = randomBytes(32).toString('hex');
    const managed = await import('@/lib/github-broker/managed');
    const queue = store.queueDeviceRevoke;
    let tokenAtQueue: string | undefined;
    vi.spyOn(store, 'queueDeviceRevoke').mockImplementation((token) => {
      tokenAtQueue = store.readDeviceSession()?.token;
      queue(token);
    });
    respond = async (path) => {
      if (path.endsWith('/renew')) managed.bumpSignInEpoch();
      return { status: 200, body: { deviceToken: rotated, ticket: randomBytes(24).toString('hex'), clerkUserId: owner, idleExpiresAt } };
    };
    const { POST } = await import('@/app/api/panel/auth/device/renew/route');
    expect((await POST(request('renew'))).status).toBe(409);
    expect(tokenAtQueue).toBe(credential);
    expect(store.readDeviceSession()).toBeNull();
  });

  it('deletes uncertain credentials without needing to persist revoke intent', async () => {
    const store = await seed();
    const queue = vi.spyOn(store, 'queueDeviceRevoke').mockImplementation(() => { throw new Error('Storage unavailable'); });
    respond = async () => ({ status: 503, body: {} });
    const { POST } = await import('@/app/api/panel/auth/device/renew/route');
    expect((await POST(request('renew'))).status).toBe(503);
    expect(store.readDeviceSession()).toBeNull();
    expect(queue).not.toHaveBeenCalled();
    queue.mockRestore();
    respond = async () => ({ status: 200, body: {} });
    expect((await POST(request('renew'))).status).toBe(401);
    expect(calls.filter((call) => call.path.endsWith('/renew'))).toHaveLength(4);
    expect(store.readDeviceSession()).toBeNull();
  });

  it('fails closed for a renewal response belonging to another owner', async () => {
    const store = await seed();
    respond = async () => ({ status: 200, body: { ticket: randomBytes(24).toString('hex'), clerkUserId: 'user_other', deviceToken: credential, idleExpiresAt } });
    const { POST } = await import('@/app/api/panel/auth/device/renew/route');
    const response = await POST(request('renew'));
    expect(response.status).toBe(409);
    expect(store.readDeviceSession()).toBeNull();
  });

  it('revokes idempotently and deletes locally even when the server is unavailable', async () => {
    const store = await seed();
    respond = async () => ({ status: 503, body: { error: credential } });
    const { POST } = await import('@/app/api/panel/auth/device/revoke/route');
    expect(await (await POST(request('revoke'))).json()).toEqual({ ok: true });
    expect(store.readDeviceSession()).toBeNull();
    expect(calls[0]).toMatchObject({ path: '/account/device/revoke', authorization: `Bearer ${credential}` });
    expect(await (await POST(request('revoke'))).json()).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    const pending = join(dataDir, 'device-revoke-pending.json');
    expect(JSON.parse(readFileSync(pending, 'utf8'))).toEqual({ version: 1, tokens: [credential] });
    expect(statSync(pending).mode & 0o777).toBe(0o600);
  });

  it.each([200, 401])('retries a pending revoke on the next launch and removes it on %s', async (status) => {
    await seed();
    respond = async () => ({ status: 503, body: {} });
    const { POST } = await import('@/app/api/panel/auth/device/revoke/route');
    await POST(request('revoke'));
    const pending = join(dataDir, 'device-revoke-pending.json');
    expect(existsSync(pending)).toBe(true);
    vi.resetModules();
    respond = async () => ({ status, body: {} });
    const { GET } = await import('@/app/api/panel/auth/device/status/route');
    expect(await (await GET(request('status'))).json()).toEqual({ present: false, clerkUserId: null });
    expect(calls).toHaveLength(2);
    expect(calls[1].authorization).toBe(`Bearer ${credential}`);
    expect(existsSync(pending)).toBe(false);
  });

  it('keeps failed pending revokes across launches without revoking a newly enrolled device', async () => {
    await seed();
    respond = async () => ({ status: 503, body: {} });
    const { POST } = await import('@/app/api/panel/auth/device/revoke/route');
    await POST(request('revoke'));
    vi.resetModules();
    const store = await import('@/lib/auth/device-session-store');
    const newer = randomBytes(32).toString('hex');
    store.writeDeviceSession({ token: newer, clerkUserId: owner, installId: 'install_device', idleExpiresAt });
    const { GET } = await import('@/app/api/panel/auth/device/status/route');
    await GET(request('status'));
    expect(calls).toHaveLength(2);
    expect(calls[1].authorization).toBe(`Bearer ${credential}`);
    expect(store.readDeviceSession()?.token).toBe(newer);
    expect(JSON.parse(readFileSync(join(dataDir, 'device-revoke-pending.json'), 'utf8'))).toEqual({ version: 1, tokens: [credential] });
  });

  it.each(['enroll', 'renew'] as const)('never resurrects a device when revoke races an in-flight %s', async (action) => {
    const store = await seed();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    respond = async (path) => {
      if (path.endsWith('/revoke')) return { status: 200, body: {} };
      await hold;
      return { status: 200, body: { deviceToken: credential, clerkUserId: owner, idleExpiresAt, ticket: randomBytes(24).toString('hex') } };
    };
    const { POST: renew } = await import('@/app/api/panel/auth/device/renew/route');
    const pending = action === 'enroll' ? enroll() : renew(request('renew'));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const { POST: revoke } = await import('@/app/api/panel/auth/device/revoke/route');
    await revoke(request('revoke'));
    release();
    expect((await pending).status).toBe(409);
    expect(store.readDeviceSession()).toBeNull();
  });

  it.each(['renew', 'status'] as const)('never rotates a token whose sign-out was interrupted after queueing its revoke (%s first)', async (first) => {
    // Sign-out queues the revoke, then deletes the file. A crash between the two
    // leaves both. Rotating that token would turn the queued revoke into a replay
    // after grace, which the server treats as reuse and answers by signing the
    // account out everywhere.
    const store = await seed();
    store.queueDeviceRevoke(credential);
    respond = async (path) => path === '/account/device/revoke'
      ? { status: 503, body: {} }
      : { status: 200, body: { ticket: randomBytes(24).toString('hex'), clerkUserId: owner, deviceToken: randomBytes(32).toString('hex'), idleExpiresAt } };
    const { POST } = await import('@/app/api/panel/auth/device/renew/route');
    const { GET } = await import('@/app/api/panel/auth/device/status/route');
    if (first === 'status') expect(await (await GET(request('status'))).json()).toEqual({ present: false, clerkUserId: null });
    const response = await POST(request('renew'));
    expect(response.status).toBe(401);
    expect(calls.filter((call) => call.path === '/account/device/renew')).toEqual([]);
    expect(existsSync(join(dataDir, 'device-session.json'))).toBe(false);
    // The queued token was never rotated, so its later revoke is an ordinary one.
    expect(store.readPendingDeviceRevokes()).toEqual([credential]);
  });

  it('treats a corrupt persisted record as absent', async () => {
    writeFileSync(join(dataDir, 'device-session.json'), '{');
    const { GET } = await import('@/app/api/panel/auth/device/status/route');
    expect(await (await GET(request('status'))).json()).toEqual({ present: false, clerkUserId: null });
  });

  it('renews through the client, clears the marker/epoch, syncs a subject-matched license and bound managed token', async () => {
    await seed();
    vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'pk_test');
    const { privateKey, publicKey } = await generateKeyPair('EdDSA');
    vi.stubEnv('O8_LICENSE_PUBKEY', await exportSPKI(publicKey));
    const license = await new SignJWT({ plan: 'founder' }).setProtectedHeader({ alg: 'EdDSA' })
      .setSubject(owner).setExpirationTime('1h').sign(privateKey);
    const session = await new SignJWT({}).setProtectedHeader({ alg: 'EdDSA' })
      .setSubject(owner).setIssuedAt().sign(privateKey);
    const managedCredential = randomBytes(32).toString('hex');
    respond = async (path) => {
      if (path === '/account/license') return { status: 200, body: { license } };
      if (path === '/github/app/token') return { status: 200, body: {
        installed: true, token: managedCredential, ownerClerkUserId: owner,
        installationId: 1, expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      } };
      if (path === '/account/device/renew') return { status: 200, body: {
        ticket: randomBytes(24).toString('hex'), clerkUserId: owner,
        deviceToken: randomBytes(32).toString('hex'), idleExpiresAt,
      } };
      return { status: 200, body: {} };
    };
    const managed = await import('@/lib/github-broker/managed');
    managed.bumpSignInEpoch();
    const priorEpoch = managed.readSignInEpoch();
    managed.writeActiveIdentity('user_other');
    managed.writeManagedGithubState({ installed: true, token: randomBytes(32).toString('hex'), ownerClerkUserId: 'user_other' });
    const marker = await import('@/lib/auth/sign-out-marker');
    const { POST: renew } = await import('@/app/api/panel/auth/device/renew/route');
    const { POST: sync } = await import('@/app/api/panel/entitlement/sync/route');
    const { renewDesktopSession, completeDesktopSignIn } = await import('@/lib/auth/device-session-client');
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      if (!input.startsWith('/api/')) return realFetch(input, init);
      const localRequest = new Request(`http://localhost${input}`, {
        ...init, headers: { host: 'localhost', 'x-o8-client-addr': '127.0.0.1', ...init?.headers },
      });
      return input.endsWith('/device/renew') ? renew(localRequest) : sync(localRequest);
    });
    try {
      const result = await renewDesktopSession({
        owner, isCurrent: () => true, signOut: vi.fn(async () => {}),
        signIn: { status: 'complete', createdSessionId: 'session_device', ticket: async () => ({}), finalize: async () => ({}) },
        clerk: { setActive: async () => { marker.markAuthSignedOut(); }, user: { id: owner, reload: async () => {} } },
        onSignInComplete: () => completeDesktopSignIn(async () => {
          expect(marker.readAuthSignedOutAt()).toBeNull();
          expect(managed.readSignInEpoch()).not.toBe(priorEpoch);
          expect(managed.readManagedGithubToken()).toBeNull();
          const response = await sync(new Request('http://localhost/api/panel/entitlement/sync', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'x-clerk-session-token': session },
            body: JSON.stringify({ clerkUserId: owner }),
          }));
          expect(await response.json()).toMatchObject({ ok: true, plan: 'founder' });
        }),
      });
      expect(result).toBe(true);
      await vi.waitFor(() => expect(managed.readManagedGithubToken()?.token).toBe(managedCredential));
      expect(managed.readActiveIdentity()).toBe(owner);
      expect(JSON.parse(readFileSync(join(dataDir, 'entitlement.json'), 'utf8')).licenseKey).toBe(license);
      expect(calls.filter((call) => ['/account/license', '/github/app/token', '/account/link-install'].includes(call.path)))
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ path: '/account/license', authorization: `Bearer ${session}` }),
          expect.objectContaining({ path: '/github/app/token', authorization: `Bearer ${session}` }),
          expect.objectContaining({ path: '/account/link-install', authorization: `Bearer ${session}` }),
        ]));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
