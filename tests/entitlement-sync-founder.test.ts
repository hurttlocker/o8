import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exportSPKI, generateKeyPair, SignJWT } from 'jose';
// @ts-expect-error jsdom is a test dependency without bundled declarations
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccountBlock } from '@/components/desktop/account-block/AccountBlock';
import { EntitlementProvider, useEntitlement } from '@/lib/entitlement/context';
import type { Plan } from '@/lib/entitlement/types';

const SUBJECT = 'user_lifetime_fixture';

vi.mock('@clerk/nextjs/server', () => ({
  auth: async () => ({ userId: null }),
}));
vi.mock('@/components/auth/O8AuthProvider', () => ({
  useO8Auth: () => ({
    clerkEnabled: true, isLoaded: true, signedIn: true,
    user: { id: 'user_lifetime_fixture', name: 'Account' },
  }),
}));
vi.mock('@/lib/theme/context', () => ({
  useTheme: () => ({ paletteId: 'light', surface: {}, workspaceGlass: false }),
}));
vi.mock('@/components/desktop/dictation/SymonMachineControl', () => ({
  SymonMachineControl: () => null, SymonOrbStatusLine: () => null,
  useSymonOrbMinimized: () => true,
}));

let dataDir: string;
let container: HTMLDivElement;
let root: Root;
let closeDom: () => void;
let signingKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

function founderPath() {
  return path.join(dataDir, 'founder.json');
}

function seedStaleSeat() {
  writeFileSync(founderPath(), JSON.stringify({
    operatorNumber: 99, tier: 2, syncedAt: '2026-01-01T00:00:00.000Z',
  }));
}

async function signedLicense(plan: Plan, subject = SUBJECT) {
  return new SignJWT({ plan })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setSubject(subject)
    .setExpirationTime('1h')
    .sign(signingKey);
}

function serveAccountLicense(data: {
  license: string;
  source: string;
  founder?: { operatorNumber: number; tier?: number };
}) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/account/license')) {
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer fixture-session' });
      return Response.json(data);
    }
    if (url.endsWith('/account/link-install')) return Response.json({});
    if (url.endsWith('/github/app/token')) return Response.json({}, { status: 503 });
    if (url.startsWith('/api/panel/entitlement?')) {
      const { GET } = await import('@/app/api/panel/entitlement/route');
      return GET(new Request(`http://localhost${url}`));
    }
    throw new Error(`Unexpected fixture request: ${url}`);
  }));
}

async function sync() {
  const { POST } = await import('@/app/api/panel/entitlement/sync/route');
  return POST(new Request('http://localhost/api/panel/entitlement/sync', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-clerk-session-token': 'fixture-session',
    },
    body: JSON.stringify({ clerkUserId: SUBJECT }),
  }));
}

async function readEntitlement() {
  const { GET } = await import('@/app/api/panel/entitlement/route');
  return (await GET(new Request(`http://localhost/api/panel/entitlement?subject=${SUBJECT}`))).json();
}

function EntitlementReady() {
  const { loading } = useEntitlement();
  return createElement('output', { 'data-entitlement-ready': !loading });
}

async function mountAccountBlock() {
  await act(async () => root.render(
    createElement(EntitlementProvider, null, createElement(AccountBlock), createElement(EntitlementReady)),
  ));
  await vi.waitFor(async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(container.querySelector('[data-entitlement-ready="true"]')).not.toBeNull();
  });
}

describe('lifetime seat through desktop entitlement sync and account rendering (#3269)', () => {
  beforeEach(async () => {
    vi.resetModules();
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-sync-seat-'));
    vi.stubEnv('CORTEX_IDE_DATA_DIR', dataDir);
    vi.stubEnv('O8_DATA_DIR', '');
    vi.stubEnv('O8_PLAN', '');
    vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'pk_test_fixture');
    const keys = await generateKeyPair('EdDSA');
    signingKey = keys.privateKey;
    vi.stubEnv('O8_LICENSE_PUBKEY', await exportSPKI(keys.publicKey));
    // Keep signing and verification in Node's typed-array realm while mounting
    // the real client components against an isolated browser document.
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
      url: 'http://localhost/dashboard',
    });
    closeDom = () => dom.window.close();
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('Node', dom.window.Node);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    closeDom();
    rmSync(dataDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each([
    { source: 'subscription', plan: 'pro' as const },
    { source: 'founding', plan: 'founder' as const },
  ])('persists the seat and renders Pro · Lifetime for a $source license', async ({ source, plan }) => {
    const license = await signedLicense(plan);
    serveAccountLicense({ license, source, founder: { operatorNumber: 7, tier: 1 } });

    const response = await sync();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, plan, source });
    expect(existsSync(founderPath())).toBe(true);
    expect(JSON.parse(readFileSync(founderPath(), 'utf8'))).toEqual({
      operatorNumber: 7, tier: 1, syncedAt: expect.any(String),
    });
    expect(JSON.parse(readFileSync(path.join(dataDir, 'entitlement.json'), 'utf8'))).toMatchObject({
      plan, status: 'active', licenseKey: license,
    });
    expect(await readEntitlement()).toMatchObject({
      plan, actualPlan: plan,
      founder: { operatorNumber: 7, tier: 1 },
      actualFounder: { operatorNumber: 7, tier: 1 },
    });

    await mountAccountBlock();
    expect(container.querySelector('[aria-label="Open account menu for Account"]')?.textContent)
      .toContain('Pro · Lifetime');
  });

  it('clears a stale seat and renders Pro when a subscription carries no seat', async () => {
    seedStaleSeat();
    serveAccountLicense({ license: await signedLicense('pro'), source: 'subscription' });

    expect(await (await sync()).json()).toMatchObject({ ok: true, plan: 'pro', source: 'subscription' });
    expect(existsSync(founderPath())).toBe(false);
    expect(await readEntitlement()).toMatchObject({ plan: 'pro', founder: null, actualFounder: null });
    await mountAccountBlock();
    const label = container.querySelector('[aria-label="Open account menu for Account"]')?.textContent;
    expect(label).toContain('Pro');
    expect(label).not.toContain('Lifetime');
  });

  it('does not persist a seat or entitlement for an invalid license signature', async () => {
    const otherKey = await generateKeyPair('EdDSA');
    const license = await new SignJWT({ plan: 'pro' })
      .setProtectedHeader({ alg: 'EdDSA' }).setSubject(SUBJECT).setExpirationTime('1h')
      .sign(otherKey.privateKey);
    serveAccountLicense({ license, source: 'subscription', founder: { operatorNumber: 7 } });

    expect(await (await sync()).json()).toMatchObject({ ok: false, reason: 'bad signature (wrong key or tampered)' });
    expect(existsSync(founderPath())).toBe(false);
    expect(existsSync(path.join(dataDir, 'entitlement.json'))).toBe(false);
  });

  it('rejects a different license subject and clears the stale seat', async () => {
    seedStaleSeat();
    serveAccountLicense({
      license: await signedLicense('pro', 'user_other_fixture'), source: 'subscription',
      founder: { operatorNumber: 7 },
    });

    const response = await sync();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, reason: 'license_subject_mismatch' });
    expect(existsSync(founderPath())).toBe(false);
    expect(existsSync(path.join(dataDir, 'entitlement.json'))).toBe(false);
  });
});
