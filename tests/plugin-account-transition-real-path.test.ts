import { generateKeyPairSync, sign } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSync } from 'esbuild';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fsFault = vi.hoisted(() => ({ after: 0, calls: 0 }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, fsyncSync(fd: number) {
    fsFault.calls += 1;
    if (fsFault.after && fsFault.calls === fsFault.after) throw new Error('Synthetic license persistence failure');
    return actual.fsyncSync(fd);
  } };
});
const clerk = vi.hoisted(() => ({ auth: vi.fn(async (): Promise<{ userId: string | null }> => ({ userId: null })) }));
vi.mock('@clerk/nextjs/server', () => ({ auth: clerk.auth }));

const keys = generateKeyPairSync('ed25519');
let dataDir: string;
let bundleDir: string;
let childBundle: string;
const children = new Set<ChildProcess>();
const originalDataDir = process.env.CORTEX_IDE_DATA_DIR;
function license(subject: string) {
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ sub: subject, plan: 'free', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  const unsigned = `${header}.${body}`;
  return `${unsigned}.${sign(null, Buffer.from(unsigned), keys.privateKey).toString('base64url')}`;
}
function session() {
  return `header.${Buffer.from(JSON.stringify({ iat: Math.floor(Date.now() / 1000) + 1 })).toString('base64url')}.signature`;
}
async function sync(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/panel/entitlement/sync/route');
  return POST(new Request('http://localhost/api/panel/entitlement/sync', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-clerk-session-token': session() },
    body: JSON.stringify(body),
  }));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeAll(() => {
  bundleDir = mkdtempSync(join(tmpdir(), 'o8-account-process-'));
  childBundle = join(bundleDir, 'account.cjs');
  buildSync({ entryPoints: ['tests/fixtures/plugin-account-process.ts'], outfile: childBundle,
    bundle: true, platform: 'node', format: 'cjs', packages: 'external',
    alias: { 'server-only': join(process.cwd(), 'tests/stubs/server-only.ts'),
      '@clerk/nextjs/server': join(process.cwd(), 'tests/fixtures/account-clerk-stub.ts') },
  });
});
afterAll(() => { rmSync(bundleDir, { recursive: true, force: true }); });
beforeEach(() => {
  vi.resetModules();
  clerk.auth.mockReset().mockResolvedValue({ userId: null });
  dataDir = mkdtempSync(join(tmpdir(), 'o8-account-transition-'));
  vi.stubEnv('CORTEX_IDE_DATA_DIR', dataDir);
  vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'pk_test');
  vi.stubEnv('O8_LICENSE_PUBKEY', keys.publicKey.export({ type: 'spki', format: 'pem' }).toString());
  vi.stubEnv('O8_PROXY_URL', 'https://account.invalid');
});
afterEach(async () => {
  for (const child of children) {
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('close', resolve));
  }
  children.clear();
  fsFault.after = 0; fsFault.calls = 0;
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  if (originalDataDir) process.env.CORTEX_IDE_DATA_DIR = originalDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

function actor(mode: string, accountId = 'user_active', token = license(accountId)) {
  const scratch = mkdtempSync(join(dataDir, 'actor-'));
  const child = spawn(process.execPath, [childBundle, mode, scratch, accountId, token], {
    env: { ...process.env, NODE_PATH: join(process.cwd(), 'node_modules') }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const done = new Promise<{ code: number | null; result: Record<string, unknown> | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      children.delete(child);
      if (code !== 0 && code !== 17) { reject(new Error(`Account fixture exit ${code}: ${stderr}`)); return; }
      resolve({ code, result: stdout ? JSON.parse(stdout) : null });
    });
  });
  return { scratch, done, release: () => writeFileSync(join(scratch, 'release'), '1') };
}
async function ready(accountId = 'user_active') {
  const token = license(accountId);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/account/license')
    ? Response.json({ license: token }) : new Response('{}', { status: 503 })));
  await sync({ clearSignInMarker: true });
  expect(await (await sync({ clerkUserId: accountId })).json()).toMatchObject({ ok: true });
  // Wait for fire-and-forget cleanup to settle before arranging deterministic barriers.
  await new Promise((resolve) => setTimeout(resolve, 150));
}
async function entered(value: ReturnType<typeof actor>, phase = 'entered') {
  await vi.waitFor(() => expect(existsSync(join(value.scratch, phase))).toBe(true), { timeout: 5000 });
}

describe('account transitions through the real entitlement sync route', () => {
  it('does not restore a delayed account license after sign-out, even with a same-second token', async () => {
    const pending = deferred<Response>();
    const started = deferred<void>();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/account/license')) { started.resolve(); return pending.promise; }
      return new Response('{}', { status: 503 });
    }));
    await sync({ clearSignInMarker: true });
    const old = sync({ clerkUserId: 'user_old' });
    await started.promise;
    await sync({ signedOut: true });
    pending.resolve(Response.json({ license: license('user_old') }));
    const result = await old;
    expect(await result.json()).toMatchObject({ ok: false, reason: 'account_state_changed' });
    const { readActiveIdentity } = await import('@/lib/github-broker/managed');
    const { readCachedEntitlement } = await import('@/lib/entitlement/license');
    expect(readActiveIdentity()).toBeNull();
    expect(readCachedEntitlement()).toBeNull();
  });

  it('does not let an old no-license response clear the new account after a fresh sign-in', async () => {
    const pending = deferred<Response>();
    const started = deferred<void>();
    let count = 0;
    const nextLicense = license('user_new');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (!String(input).endsWith('/account/license')) return new Response('{}', { status: 503 });
      if (count++ === 0) { started.resolve(); return pending.promise; }
      return Response.json({ license: nextLicense });
    }));
    await sync({ clearSignInMarker: true });
    const old = sync({ clerkUserId: 'user_old' });
    await started.promise;
    await sync({ clearSignInMarker: true });
    expect(await (await sync({ clerkUserId: 'user_new' })).json()).toMatchObject({ ok: true });
    pending.resolve(new Response('{}', { status: 404 }));
    expect(await (await old).json()).toMatchObject({ ok: false, reason: 'account_state_changed' });
    const { getDataDir } = await import('@/lib/data-dir-migration');
    expect(JSON.parse(readFileSync(join(getDataDir(), 'entitlement.json'), 'utf8')).licenseKey).toBe(nextLicense);
  });

  it('blocks a competing process before its child creation while sign-out holds the lease', async () => {
    await ready();
    const transition = actor('transition');
    await entered(transition);
    const admission = actor('admit');
    await entered(admission, 'started');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(existsSync(join(admission.scratch, 'entered'))).toBe(false);
    expect(existsSync(join(admission.scratch, 'children'))).toBe(false);
    transition.release();
    expect((await transition.done).result).toMatchObject({ reason: 'signed_out' });
    expect((await admission.done).result).toEqual({ admitted: false });
    expect(existsSync(join(admission.scratch, 'children'))).toBe(false);
  });

  it('retains admission ownership through actual child creation before a competing sign-out can commit', async () => {
    await ready();
    const admission = actor('admit-wait');
    await entered(admission);
    const transition = actor('signout');
    await entered(transition, 'started');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(existsSync(join(dataDir, 'auth-signed-out-at'))).toBe(false);
    admission.release();
    expect((await admission.done).result).toEqual({ admitted: true });
    expect(readFileSync(join(admission.scratch, 'children'), 'utf8')).toBe('run\n');
    await transition.done;
    expect((await actor('admit').done).result).toEqual({ admitted: false });
  });

  it('reclaims only a dead owner and keeps a crash-interrupted transition blocked until fresh verified sign-in', async () => {
    await ready();
    expect((await actor('crash-transition').done).code).toBe(17);
    expect((await actor('admit').done).result).toEqual({ admitted: false });
    await ready();
    expect((await actor('admit').done).result).toEqual({ admitted: true });
  });

  it('allows safe cold re-entry after complete ready publication followed by process death', async () => {
    expect((await actor('crash-ready').done).code).toBe(17);
    expect((await actor('admit').done).result).toEqual({ admitted: true });
  });

  it('refuses a delayed license success across independent refresh and sign-out processes', async () => {
    await ready();
    const refresh = actor('refresh');
    await entered(refresh, 'fetching');
    await actor('signout').done;
    refresh.release();
    expect((await refresh.done).result).toMatchObject({ ok: false, reason: 'account_state_changed' });
    expect((await actor('admit').done).result).toEqual({ admitted: false });
  });

  it('refuses escaped asynchronous writer authority after release and rejects nested admission mutation', async () => {
    await ready();
    const { withAccountStateLease } = await import('@/lib/auth/account-state');
    const { markAuthSignedOut } = await import('@/lib/auth/sign-out-marker');
    const { withTaskDraftAccountAdmission } = await import('@/lib/mcp/task-draft-account');
    const go = deferred<void>();
    let escaped!: Promise<void>;
    await withAccountStateLease(() => { escaped = go.promise.then(() => markAuthSignedOut()); });
    go.resolve();
    await expect(escaped).rejects.toThrow();
    await expect(withTaskDraftAccountAdmission({ accountId: 'user_active', expiresAt: Infinity }, undefined,
      () => markAuthSignedOut())).rejects.toThrow();
    expect(existsSync(join(dataDir, 'auth-signed-out-at'))).toBe(false);
  });

  it('holds missing and corrupt admission journals even when legacy identity and license files are valid', async () => {
    await ready();
    rmSync(join(dataDir, 'account-state.sqlite'));
    expect((await actor('admit').done).result).toEqual({ admitted: false });
    writeFileSync(join(dataDir, 'account-state.sqlite'), 'corrupt journal');
    expect((await actor('admit').done).result).toEqual({ admitted: false });
  });

  it.each([200, 403, 503])('fences an old managed-token response (%s) after another account is ready', async (status) => {
    await ready('user_old');
    const pending = deferred<Response>();
    const started = deferred<void>();
    const nextLicense = license('user_new');
    let count = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/github/app/token') && count++ === 0) { started.resolve(); return pending.promise; }
      if (url.endsWith('/account/license')) return Response.json({ license: count === 0 ? license('user_old') : nextLicense });
      return new Response('{}', { status: 503 });
    }));
    expect(await (await sync({ clerkUserId: 'user_old' })).json()).toMatchObject({ ok: true });
    await started.promise;
    await sync({ clearSignInMarker: true });
    expect(await (await sync({ clerkUserId: 'user_new' })).json()).toMatchObject({ ok: true });
    pending.resolve(status === 200 ? Response.json({ installed: true, ownerClerkUserId: 'user_old',
      token: 'fixture-old-token', installationId: 1, expiresAt: new Date(Date.now() + 3600000).toISOString() })
      : new Response('{}', { status }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    const { readActiveIdentity, readManagedGithubState } = await import('@/lib/github-broker/managed');
    expect(readActiveIdentity()).toBe('user_new');
    expect(readManagedGithubState()?.ownerClerkUserId).not.toBe('user_old');
    expect(JSON.parse(readFileSync(join(dataDir, 'entitlement.json'), 'utf8')).licenseKey).toBe(nextLicense);
  });

  it('keeps an interrupted license persistence blocked and permits a later complete verified refresh', async () => {
    await ready();
    fsFault.calls = 0;
    fsFault.after = 3;
    expect(await (await sync({ clerkUserId: 'user_active' })).json()).toMatchObject({ ok: false });
    fsFault.after = 0;
    expect((await actor('admit').done).result).toEqual({ admitted: false });
    await ready();
    expect((await actor('admit').done).result).toEqual({ admitted: true });
  });

  it('does not evict a replacement license when an old entitlement GET finishes resolving its subject', async () => {
    await ready('user_old');
    const pending = deferred<void>(); const started = deferred<void>();
    clerk.auth.mockImplementationOnce(async () => {
      started.resolve(); await pending.promise; return { userId: 'user_old' };
    });
    const { GET } = await import('@/app/api/panel/entitlement/route');
    const old = GET(new Request('http://localhost/api/panel/entitlement'));
    await started.promise;
    await ready('user_new');
    const persisted = readFileSync(join(dataDir, 'entitlement.json'), 'utf8');
    pending.resolve(); await old;
    expect(readFileSync(join(dataDir, 'entitlement.json'), 'utf8')).toBe(persisted);
    expect((await actor('admit', 'user_new').done).result).toEqual({ admitted: true });
  });

  it.each(['same-second', 'missing', 'aged-out'])('keeps explicit sign-out held for a later old-token sync (%s)', async (kind) => {
    await ready();
    await sync({ signedOut: true });
    if (kind === 'aged-out') writeFileSync(join(dataDir, 'auth-signed-out-at'), `${Math.floor(Date.now() / 1000) - 8 * 86400}\n`);
    const { POST } = await import('@/app/api/panel/entitlement/sync/route');
    const credential = kind === 'missing' ? 'fixture-no-iat' : session();
    const response = await POST(new Request('http://localhost/api/panel/entitlement/sync', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-clerk-session-token': credential },
      body: JSON.stringify({ clerkUserId: 'user_active' }),
    }));
    expect(await response.json()).toMatchObject({ ok: false, reason: 'stale_session' });
    expect(existsSync(join(dataDir, 'entitlement.json'))).toBe(false);
    expect((await actor('admit').done).result).toEqual({ admitted: false });
  });

  it.each(['async', 'sync'])('releases an inactive %s reservation after separate-process SQLite contention', async (kind) => {
    await ready();
    const { withAccountStateLease, withSynchronousAccountStateLease } = await import('@/lib/auth/account-state');
    let blocker!: ReturnType<typeof actor>;
    let released = false;
    if (kind === 'async') {
      const pending = withAccountStateLease(async () => {
        blocker = actor('db-write-lock'); await entered(blocker);
      }).then(() => { released = true; });
      await vi.waitFor(() => expect(blocker && existsSync(join(blocker.scratch, 'entered'))).toBe(true));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(released).toBe(false);
      blocker.release(); await blocker.done; await pending;
    } else {
      withSynchronousAccountStateLease(() => {
        blocker = actor('db-write-lock');
        const deadline = Date.now() + 5000;
        // Only the test blocks briefly to coordinate a real external process;
        // the production synchronous release must return without waiting.
        while (!existsSync(join(blocker.scratch, 'entered'))) {
          if (Date.now() > deadline) throw new Error('Database blocker did not start.');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        }
      });
      blocker.release(); await blocker.done;
    }
    expect((await actor('admit').done).result).toEqual({ admitted: true });
    // The owner process remains alive; another local acquisition also succeeds.
    await withAccountStateLease(() => {});
  });
});
