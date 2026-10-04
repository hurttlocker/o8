import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportSPKI, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@clerk/nextjs/server', () => ({ auth: async () => ({ userId: null }) }));

const owner = 'user_device';
let dataDir: string;
let server: Server;
let calls: Array<{ path: string; authorization?: string; body: unknown }>;
let respond: (path: string) => Promise<{ status: number; body: unknown }>;
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

  it('keeps the device on a transient upstream failure', async () => {
    const store = await seed();
    respond = async () => ({ status: 503, body: { error: credential } });
    const { POST } = await import('@/app/api/panel/auth/device/renew/route');
    const response = await POST(request('renew'));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(credential);
    expect(store.readDeviceSession()?.token).toBe(credential);
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
    expect(calls).toHaveLength(1);
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
