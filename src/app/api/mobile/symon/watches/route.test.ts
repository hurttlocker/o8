/**
 * The phone's watch surface, driven through the REAL route handlers.
 *
 * Every watch here is registered through the operator POST route, so the rows
 * and their ledger entries are the ones a live Symon turn would leave behind;
 * the list and the cancel then run with a bearer minted by the actual device
 * registry, which is the credential a paired phone presents over the relay.
 * Asserting on `cancelSymonWatch` directly would prove the mechanism and not
 * that anyone can reach it.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

const dataDir = mkdtempSync(join(tmpdir(), 'o8-mobile-symon-watches-'));
const WORKER_TOKEN = 'mobile-watches-worker-token-0123456789';
writeFileSync(join(dataDir, 'worker-token'), `${WORKER_TOKEN}\n`, 'utf-8');
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;

const repoPath = mkdtempSync(join(tmpdir(), 'o8-mobile-symon-watches-repo-'));

const listRoute = await import('@/app/api/mobile/symon/watches/route');
const cancelRoute = await import('@/app/api/mobile/symon/watches/[id]/route');
const operatorWatchesRoute = await import('@/app/api/symon/watches/route');
const { getSqlite, closeDb } = await import('@/lib/db');
const { enrollDevice } = await import('@/lib/mobile/device-registry');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const { readSymonWatchLedger, closeSymonWatchLedger } = await import('@/lib/automations/symon-watch-ledger');

const { deviceToken } = enrollDevice({
  identityPublicKey: 'mobile-watches-fixture-identity-key',
  deviceLabel: 'fixture phone',
});
const operatorToken = getOrCreateWsToken().trim();

interface MobileWatch {
  id: string;
  condition: string;
  then: string | null;
  summary: string;
  deadline: number | null;
  state: string;
  parked: boolean;
  nudgedAt: number | null;
  lastLedgerEvent: { phase: string; outcome: string } | null;
}

function authHeaders(token: string | null): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

function listWatches(token: string | null) {
  return listRoute.GET(new NextRequest('http://localhost/api/mobile/symon/watches', {
    headers: authHeaders(token),
  }));
}

function cancelWatch(id: string, token: string | null) {
  return cancelRoute.DELETE(
    new NextRequest(`http://localhost/api/mobile/symon/watches/${id}`, {
      method: 'DELETE',
      headers: authHeaders(token),
    }),
    { params: Promise.resolve({ id }) },
  );
}

async function readWatches(token: string | null): Promise<MobileWatch[]> {
  const response = await listWatches(token);
  expect(response.status, await response.clone().text()).toBe(200);
  const body = await response.json() as { ok: boolean; watches: MobileWatch[] };
  expect(body.ok).toBe(true);
  return body.watches;
}

/** Register one watch the way a live Symon turn does — through its own route. */
async function createWatch(input: {
  text: string;
  sourceId: string;
  then: Record<string, unknown>;
}): Promise<{ id: string }> {
  const response = await operatorWatchesRoute.POST(new Request('http://localhost/api/symon/watches', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId: 'symon-mobile-watches-test',
      condition: {
        text: input.text,
        source: 'repository',
        id: input.sourceId,
        events: ['check_suite_completed'],
        repoPath,
      },
      then: input.then,
    }),
  }));
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json() as { watch: { id: string } }).watch;
}

beforeEach(() => {
  const sqlite = getSqlite();
  sqlite.prepare('DELETE FROM automation_fires').run();
  sqlite.prepare('DELETE FROM automations').run();
});

afterAll(() => {
  closeSymonWatchLedger();
  closeDb();
});

describe('GET /api/mobile/symon/watches', () => {
  it('returns every standing intent with the fields the phone row renders', async () => {
    const report = await createWatch({
      text: 'tell me when the checks on the release branch finish',
      sourceId: 'repo-checks-1',
      then: { kind: 'report', say: 'The release checks are done.' },
    });
    const plan = await createWatch({
      text: 'when that pull request merges, catch me up',
      sourceId: 'repo-merge-1',
      then: {
        kind: 'plan',
        say: 'That pull request merged.',
        steps: [{ tool: 'o8_status', args: {} }, { tool: 'o8_recap', args: {} }],
      },
    });

    const watches = await readWatches(deviceToken);
    expect(watches).toHaveLength(2);

    const reportWatch = watches.find((watch) => watch.id === report.id);
    expect(reportWatch).toMatchObject({
      id: report.id,
      condition: 'tell me when the checks on the release branch finish',
      then: 'report',
      summary: 'The release checks are done.',
      state: 'active',
      parked: false,
      nudgedAt: null,
    });
    expect(reportWatch?.deadline).toBeGreaterThan(Date.now());
    expect(reportWatch?.lastLedgerEvent).toMatchObject({
      phase: 'watch_registered',
      outcome: 'watching',
    });

    // A plan body is summarized by what it will do, not by its raw arguments.
    const planWatch = watches.find((watch) => watch.id === plan.id);
    expect(planWatch?.then).toBe('plan');
    expect(planWatch?.summary).toBe('That pull request merged. Then: o8_status, o8_recap.');
  });

  it('answers the operator bearer as well as a paired device token', async () => {
    const watch = await createWatch({
      text: 'tell me when the nightly workflow finishes',
      sourceId: 'repo-nightly-1',
      then: { kind: 'report', say: 'The nightly run finished.' },
    });
    const watches = await readWatches(operatorToken);
    expect(watches.map((entry) => entry.id)).toEqual([watch.id]);
  });

  it('refuses a caller with no credential and a dispatched worker', async () => {
    expect((await listWatches(null)).status).toBe(401);
    expect((await listWatches('not-a-real-token')).status).toBe(401);
    expect((await listWatches(WORKER_TOKEN)).status).toBe(403);
  });
});

describe('DELETE /api/mobile/symon/watches/[id]', () => {
  it('closes the row and writes the watch_cancelled ledger entry', async () => {
    const watch = await createWatch({
      text: 'tell me when the deploy workflow finishes',
      sourceId: 'repo-deploy-1',
      then: { kind: 'report', say: 'The deploy finished.' },
    });

    const response = await cancelWatch(watch.id, deviceToken);
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await response.json() as { ok: boolean; watch: MobileWatch };
    expect(body.ok).toBe(true);
    expect(body.watch).toMatchObject({ id: watch.id, state: 'cancelled', parked: false });

    const row = getSqlite()
      .prepare('SELECT enabled FROM automations WHERE id = ?')
      .get(watch.id) as { enabled: number };
    expect(row.enabled).toBe(0);
    expect(readSymonWatchLedger(watch.id, 1)[0]).toMatchObject({
      phase: 'watch_cancelled',
      outcome: 'cancelled',
    });

    const listed = await readWatches(deviceToken);
    expect(listed.find((entry) => entry.id === watch.id)?.state).toBe('cancelled');
  });

  it('is idempotent on an already-cancelled watch and 404s an unknown id', async () => {
    const watch = await createWatch({
      text: 'tell me when the docs workflow finishes',
      sourceId: 'repo-docs-1',
      then: { kind: 'report', say: 'The docs run finished.' },
    });

    expect((await cancelWatch(watch.id, deviceToken)).status).toBe(200);
    const second = await cancelWatch(watch.id, deviceToken);
    expect(second.status).toBe(200);
    expect((await second.json() as { watch: MobileWatch }).watch.state).toBe('cancelled');

    const unknown = await cancelWatch('watch_does_not_exist', deviceToken);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ ok: false, error: 'not_found' });
  });

  it('accepts the operator bearer and refuses an unauthenticated cancel', async () => {
    const watch = await createWatch({
      text: 'tell me when the lint workflow finishes',
      sourceId: 'repo-lint-1',
      then: { kind: 'report', say: 'The lint run finished.' },
    });

    expect((await cancelWatch(watch.id, null)).status).toBe(401);
    expect((await cancelWatch(watch.id, WORKER_TOKEN)).status).toBe(403);
    expect(getSqlite().prepare('SELECT enabled FROM automations WHERE id = ?').get(watch.id))
      .toMatchObject({ enabled: 1 });

    expect((await cancelWatch(watch.id, operatorToken)).status).toBe(200);
  });
});
