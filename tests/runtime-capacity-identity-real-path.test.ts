import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@clerk/nextjs/server', () => ({
  clerkMiddleware: (handler: unknown) => handler,
}));

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'o8-capacity-identity-'));
const dataDir = path.join(tempRoot, 'data');
const wsToken = 'capacity-operator-token-0123456789abcdef';
mkdirSync(dataDir, { recursive: true });
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
writeFileSync(path.join(dataDir, 'ws-token'), `${wsToken}\n`, 'utf8');

const capacityRoute = await import('@/app/api/runtime/capacity/route');
const { panelGateMiddleware } = await import('@/middleware');
const idempotency = await import('@/lib/orchestrator/idempotency-store');
const { getSqlite } = await import('@/lib/db');
const { resetRuntimeCapacityServiceForTests } = await import('@/lib/runtime/capacity-service');
const identityCatalog = await import('@/lib/runtime/identity-catalog');

function request(method: 'GET' | 'POST', body?: unknown, query = ''): NextRequest {
  return new NextRequest(`http://localhost:3001/api/runtime/capacity${query}`, {
    method,
    headers: {
      host: 'localhost:3001',
      authorization: `Bearer ${wsToken}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function makeCodexHome(name: string, secret: string): string {
  const home = path.join(tempRoot, name);
  mkdirSync(path.join(home, 'sessions', '2026', '08', '12'), { recursive: true });
  writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ token: secret }), 'utf8');
  writeFileSync(path.join(home, 'sessions', '2026', '08', '12', 'rollout.jsonl'), `${JSON.stringify({
    timestamp: new Date().toISOString(),
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        primary: { window_minutes: 300, used_percent: 18, resets_at: Math.floor(Date.now() / 1000) + 3600 },
      },
    },
  })}\n`, 'utf8');
  return home;
}

async function register(home: string, label: string, clientMutationId: string) {
  return capacityRoute.POST(request('POST', {
    action: 'register',
    runtime: 'codex',
    label,
    configHomeRef: home,
    clientMutationId,
  }));
}

function insertDeadReservation(input: {
  verb: string;
  scopeId: string;
  clientMutationId: string;
  body: string;
}) {
  const key = idempotency.deriveIdempotencyKey({
    verb: input.verb,
    scopeId: input.scopeId,
    clientKey: input.clientMutationId,
    body: input.body,
  });
  const now = Date.now();
  getSqlite().prepare(`
    INSERT INTO idempotency_keys
      (key, verb, packet_id, result_json, pid, reservation_id, created_at, expires_at)
    VALUES (?, ?, ?, NULL, NULL, 'dead-capacity-reservation', ?, ?)
  `).run(key, input.verb, input.scopeId, now, now + 600_000);
}

beforeEach(() => {
  rmSync(path.join(dataDir, 'runtime-identities.json'), { force: true });
  idempotency.__resetIdempotencyStoreForTests();
  resetRuntimeCapacityServiceForTests();
  identityCatalog.resetRuntimeIdentityCatalogForTests();
});

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('runtime capacity and identity route', () => {
  it('requires the operator bearer through the production API middleware', () => {
    const denied = panelGateMiddleware(new NextRequest('http://localhost:3001/api/runtime/capacity', {
      headers: { host: 'localhost:3001', 'x-o8-client-addr': '127.0.0.1' },
    }));
    const allowed = panelGateMiddleware(request('GET'));

    expect(denied.status).toBe(401);
    expect(allowed.status).toBe(200);
  });

  it('registers and selects a Codex config home without projecting paths or auth state', async () => {
    const secret = 'raw-provider-secret-must-not-leak';
    const home = makeCodexHome('identity-a', secret);
    const registered = await register(home, 'Work subscription', 'identity-register-a');
    expect(registered.status).toBe(200);
    const registration = await registered.json() as { identity: { id: string } };
    expect(JSON.stringify(registration)).not.toContain(home);
    expect(JSON.stringify(registration)).not.toContain(secret);

    const selected = await capacityRoute.POST(request('POST', {
      action: 'select',
      runtime: 'codex',
      identityId: registration.identity.id,
      clientMutationId: 'identity-select-a',
    }));
    expect(selected.status).toBe(200);

    const response = await capacityRoute.GET(request('GET', undefined, '?fresh=1'));
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    const serialized = JSON.stringify(body);
    expect(body).toMatchObject({ schema: 'o8/runtime-capacity-control/v1' });
    const capacities = body.capacities as Array<Record<string, unknown>>;
    const identities = body.identities as Array<Record<string, unknown>>;
    expect(capacities).toContainEqual(expect.objectContaining({
      runtime: 'codex',
      identityId: null,
      confidence: 'exact',
    }));
    expect(capacities.find((capacity) => (
      capacity.runtime === 'codex'
      && capacity.identityId === registration.identity.id
    ))).toMatchObject({
      identityId: registration.identity.id,
      status: 'available',
      confidence: 'exact',
    });
    expect(identities).toContainEqual(expect.objectContaining({
      id: registration.identity.id,
      label: 'Work subscription',
      selected: true,
    }));
    expect(serialized).not.toContain(home);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('auth.json');
  }, 30_000);

  it('observes every registered identity while keeping one selected for new turns', async () => {
    const homeA = makeCodexHome('observed-identity-a', 'secret-a');
    const homeB = makeCodexHome('observed-identity-b', 'secret-b');
    const registrationA = await (await register(homeA, 'A', 'observe-register-a')).json() as { identity: { id: string } };
    const registrationB = await (await register(homeB, 'B', 'observe-register-b')).json() as { identity: { id: string } };
    expect((await capacityRoute.POST(request('POST', {
      action: 'select',
      runtime: 'codex',
      identityId: registrationB.identity.id,
      clientMutationId: 'observe-select-b',
    }))).status).toBe(200);

    const response = await capacityRoute.GET(request('GET', undefined, '?fresh=1'));
    const body = await response.json() as { capacities: Array<{ identityId: string | null }> };
    expect(body.capacities.filter((capacity) => capacity.identityId).map((capacity) => capacity.identityId).sort()).toEqual([
      registrationA.identity.id,
      registrationB.identity.id,
    ].sort());
  });

  it('reconciles register and select receipts after the process dies after the catalog write', async () => {
    const home = realpathSync(makeCodexHome('reconciled-identity', 'secret-a'));
    const identity = await identityCatalog.registerRuntimeIdentity({ runtime: 'codex', label: 'Recovered', configHomeRef: home });
    const registerMutation = {
      action: 'register' as const,
      clientMutationId: 'crashed-register',
      runtime: 'codex',
      label: 'Recovered',
      configHomeRef: home,
    };
    insertDeadReservation({
      verb: 'runtime_identity_register',
      scopeId: 'codex',
      clientMutationId: registerMutation.clientMutationId,
      body: JSON.stringify(registerMutation),
    });
    expect(await identityCatalog.reconcileRuntimeIdentityMutation(registerMutation)).toMatchObject({ id: identity.id });
    const registered = await capacityRoute.POST(request('POST', registerMutation));
    expect(registered.status).toBe(200);
    expect(await registered.json()).toMatchObject({
      ok: true,
      replayed: true,
      identity: { id: identity.id, label: 'Recovered' },
    });

    await identityCatalog.selectRuntimeIdentity('codex', identity.id);
    const selectMutation = {
      action: 'select' as const,
      clientMutationId: 'crashed-select',
      runtime: 'codex',
      identityId: identity.id,
    };
    insertDeadReservation({
      verb: 'runtime_identity_select',
      scopeId: 'codex',
      clientMutationId: selectMutation.clientMutationId,
      body: JSON.stringify(selectMutation),
    });
    const selected = await capacityRoute.POST(request('POST', selectMutation));
    expect(selected.status).toBe(200);
    expect(await selected.json()).toMatchObject({
      ok: true,
      replayed: true,
      identity: { id: identity.id },
    });
  });

  it('binds clientMutationId to the exact identity mutation body', async () => {
    const homeA = makeCodexHome('identity-a', 'secret-a');
    const homeB = makeCodexHome('identity-b', 'secret-b');
    expect((await register(homeA, 'A', 'same-register-key')).status).toBe(200);
    const conflict = await register(homeB, 'B', 'same-register-key');
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      ok: false,
      error: 'clientMutationId was already used for a different identity mutation.',
    });
  });

  it('fails closed on malformed catalog state and does not overwrite it', async () => {
    const home = makeCodexHome('identity-a', 'secret-a');
    const catalogPath = path.join(dataDir, 'runtime-identities.json');
    writeFileSync(catalogPath, '{ malformed provider state', 'utf8');

    const mutation = await register(home, 'A', 'malformed-catalog-register');
    expect(mutation.status).toBe(500);
    expect(await mutation.json()).toEqual({
      ok: false,
      error: 'Identity state could not be updated.',
    });
    expect(readFileSync(catalogPath, 'utf8')).toBe('{ malformed provider state');

    resetRuntimeCapacityServiceForTests();
    const read = await capacityRoute.GET(request('GET', undefined, '?fresh=1'));
    expect(read.status).toBe(503);
    expect(JSON.stringify(await read.json())).not.toContain(home);
  });

  it('keeps identity changes operator-only through the real route', async () => {
    const home = makeCodexHome('identity-a', 'secret-a');
    const anonymous = new NextRequest('http://localhost:3001/api/runtime/capacity', {
      method: 'POST',
      headers: { host: 'localhost:3001', 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'register',
        runtime: 'codex',
        label: 'A',
        configHomeRef: home,
        clientMutationId: 'anonymous-register',
      }),
    });
    expect((await capacityRoute.POST(anonymous)).status).toBe(403);
  });
});
