/**
 * Truth-query authorization through the real token mint, middleware, route,
 * artifact store, mission store, and receipt verifier seams.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, describe, expect, it } from 'vitest';

import type { PacketReceipt } from '@/lib/receipts/types';
import {
  createNameCollisionTruthFixture,
  createTruthFixture,
} from './helpers/truth-query-fixture';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-truth-authz-real-path-'));
const workerToken = 'truth-authz-worker-token-cafebabe0123456789';
const operatorToken = 'truth-authz-operator-token-cafef00d012345';
const originalO8DataDir = process.env.O8_DATA_DIR;
const originalCortexDataDir = process.env.CORTEX_IDE_DATA_DIR;

writeFileSync(path.join(dataDir, 'worker-token'), `${workerToken}\n`, 'utf8');
writeFileSync(path.join(dataDir, 'ws-token'), `${operatorToken}\n`, 'utf8');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const broadcastTokens = await import('@/app/api/broadcast/tokens/route');
const truth = await import('@/app/api/orchestrator/truth/route');
const { panelGateMiddleware } = await import('@/middleware');
const { closeDb } = await import('@/lib/db');

type Principal = 'operator' | 'worker' | 'spectator';

function req(
  url: string,
  input: {
    principal: Principal;
    method?: string;
    body?: unknown;
    spectatorToken?: string;
  },
): NextRequest {
  const headers: Record<string, string> = { host: 'localhost:3001' };
  if (input.principal === 'operator') headers.authorization = `Bearer ${operatorToken}`;
  if (input.principal === 'worker') headers.authorization = `Bearer ${workerToken}`;
  if (input.principal === 'spectator' && input.spectatorToken) {
    headers.authorization = `Bearer ${input.spectatorToken}`;
  }
  return new NextRequest(url, {
    method: input.method ?? 'GET',
    headers,
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });
}

async function mintSpectator(repoGrants: string[]): Promise<{
  bearer: string;
  token: { repoGrants: string[] };
}> {
  const response = await broadcastTokens.POST(req(
    'http://localhost:3001/api/broadcast/tokens',
    {
      principal: 'operator',
      method: 'POST',
      body: { action: 'mint', label: 'truth authorization', repoGrants },
    },
  ));
  expect(response.status).toBe(200);
  return response.json() as Promise<{
    bearer: string;
    token: { repoGrants: string[] };
  }>;
}

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
  if (originalO8DataDir === undefined) delete process.env.O8_DATA_DIR;
  else process.env.O8_DATA_DIR = originalO8DataDir;
  if (originalCortexDataDir === undefined) delete process.env.CORTEX_IDE_DATA_DIR;
  else process.env.CORTEX_IDE_DATA_DIR = originalCortexDataDir;
});

describe.sequential('truth-query authz real path', () => {
  it('answers all three repo-scoped queries and returns the exact stored receipt bytes', async () => {
    const fixture = await createTruthFixture();
    const minted = await mintSpectator(['example.test/team/repo-a']);
    const mergedRequest = req(
      'http://localhost:3001/api/orchestrator/truth?kind=merged-since&repo=repo-a&since=2026-01-01T00:00:00.000Z',
      { principal: 'spectator', spectatorToken: minted.bearer },
    );
    expect(panelGateMiddleware(mergedRequest).status).toBe(200);
    const mergedResponse = await truth.GET(mergedRequest);
    expect(mergedResponse.status).toBe(200);
    const mergedPayload = await mergedResponse.json() as {
      answers: Array<{ receipt: PacketReceipt; receiptRaw: string }>;
    };
    const mergedAnswer = mergedPayload.answers.find((answer) => (
      answer.receipt.packetId === fixture.packetA.id
    ));
    expect(mergedAnswer).toBeDefined();
    const artifactBytes = readFileSync(fixture.receiptAPath);
    expect(Buffer.from(mergedAnswer!.receiptRaw, 'utf8')).toEqual(artifactBytes);

    const packetById = await truth.GET(req(
      `http://localhost:3001/api/orchestrator/truth?kind=packet&packetId=${fixture.packetA.id}`,
      { principal: 'spectator', spectatorToken: minted.bearer },
    ));
    expect(packetById.status).toBe(200);
    await expect(packetById.json()).resolves.toMatchObject({
      answers: [{ receipt: { packetId: fixture.packetA.id } }],
    });

    const packetByIssue = await truth.GET(req(
      `http://localhost:3001/api/orchestrator/truth?kind=packet&issueNumber=${fixture.issueA}`,
      { principal: 'spectator', spectatorToken: minted.bearer },
    ));
    expect(packetByIssue.status).toBe(200);
    await expect(packetByIssue.json()).resolves.toMatchObject({
      answers: [{ receipt: { packetId: fixture.packetA.id } }],
    });

    const approvals = await truth.GET(req(
      `http://localhost:3001/api/orchestrator/truth?kind=approvals&packetId=${fixture.packetA.id}`,
      { principal: 'spectator', spectatorToken: minted.bearer },
    ));
    expect(approvals.status).toBe(200);
    await expect(approvals.json()).resolves.toMatchObject({
      answers: [{
        summary: expect.stringContaining('operator approved'),
        receipt: { packetId: fixture.packetA.id },
      }],
    });

    const { signature, ...unsigned } = mergedAnswer!.receipt;
    const canonicalBytes = new TextEncoder().encode(fixture.canonicalJson(unsigned));
    expect(fixture.verifyReceiptBytes(canonicalBytes, signature, fixture.publicKey)).toBe(true);
  });

  it('denies repo B and hides repo B packet and issue existence from a repo A spectator', async () => {
    const fixture = await createTruthFixture();
    const minted = await mintSpectator(['example.test/team/repo-a']);
    const repoB = await truth.GET(req(
      'http://localhost:3001/api/orchestrator/truth?kind=merged-since&repo=repo-b&since=2026-01-01T00:00:00.000Z',
      { principal: 'spectator', spectatorToken: minted.bearer },
    ));
    expect(repoB.status).toBe(403);

    for (const query of [
      `kind=packet&packetId=${fixture.packetB.id}`,
      `kind=packet&issueNumber=${fixture.issueB}`,
      `kind=approvals&packetId=${fixture.packetB.id}`,
    ]) {
      const response = await truth.GET(req(
        `http://localhost:3001/api/orchestrator/truth?${query}`,
        { principal: 'spectator', spectatorToken: minted.bearer },
      ));
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ answers: [], nextCursor: null });
    }
  });

  it('requires spectator grants, admits the operator across repos, and rejects workers', async () => {
    const fixture = await createTruthFixture();
    const ungranted = await mintSpectator([]);
    const query = `kind=packet&packetId=${fixture.packetB.id}`;

    expect((await truth.GET(req(
      `http://localhost:3001/api/orchestrator/truth?${query}`,
      { principal: 'spectator', spectatorToken: ungranted.bearer },
    ))).status).toBe(403);

    const operatorResponse = await truth.GET(req(
      `http://localhost:3001/api/orchestrator/truth?${query}`,
      { principal: 'operator' },
    ));
    expect(operatorResponse.status).toBe(200);
    await expect(operatorResponse.json()).resolves.toMatchObject({
      answers: [{ receipt: { packetId: fixture.packetB.id } }],
    });

    const workerRequest = req(
      `http://localhost:3001/api/orchestrator/truth?${query}`,
      { principal: 'worker' },
    );
    expect(panelGateMiddleware(workerRequest).status).toBe(403);
    expect((await truth.GET(workerRequest)).status).toBe(403);
  });

  it('binds a name grant to one registered path and surfaces colliding registrations', async () => {
    const fixture = await createNameCollisionTruthFixture();
    writeFileSync(path.join(dataDir, 'repos.json'), JSON.stringify({
      version: 1,
      repos: [{ name: 'repo', localPath: fixture.registeredRepoPath }],
    }), 'utf8');
    const bareName = await mintSpectator(['repo']);
    const bareNameResponse = await truth.GET(req(
      'http://localhost:3001/api/orchestrator/truth?kind=merged-since&repo=repo&since=2026-01-01T00:00:00.000Z',
      { principal: 'spectator', spectatorToken: bareName.bearer },
    ));
    expect(bareNameResponse.status).toBe(403);
    await expect(bareNameResponse.json()).resolves.toMatchObject({
      error: { code: 'spectator_repo_forbidden' },
    });

    const minted = await mintSpectator(['name:REPO']);
    expect(minted.token.repoGrants).toEqual(['name:repo']);

    const allowed = await truth.GET(req(
      'http://localhost:3001/api/orchestrator/truth?kind=merged-since&repo=repo&since=2026-01-01T00:00:00.000Z',
      { principal: 'spectator', spectatorToken: minted.bearer },
    ));
    expect(allowed.status).toBe(200);
    await expect(allowed.json()).resolves.toMatchObject({
      answers: [{ receipt: { packetId: fixture.registered.packet.id } }],
    });

    const excluded = await truth.GET(req(
      `http://localhost:3001/api/orchestrator/truth?kind=packet&packetId=${fixture.other.packet.id}`,
      { principal: 'spectator', spectatorToken: minted.bearer },
    ));
    expect(excluded.status).toBe(200);
    await expect(excluded.json()).resolves.toMatchObject({ answers: [] });

    writeFileSync(path.join(dataDir, 'repos.json'), JSON.stringify({
      version: 1,
      repos: [
        { name: 'repo', localPath: fixture.registeredRepoPath },
        { name: 'repo', localPath: fixture.otherRepoPath },
      ],
    }), 'utf8');
    const ambiguous = await truth.GET(req(
      'http://localhost:3001/api/orchestrator/truth?kind=merged-since&repo=repo&since=2026-01-01T00:00:00.000Z',
      { principal: 'spectator', spectatorToken: minted.bearer },
    ));
    expect(ambiguous.status).toBe(403);
    await expect(ambiguous.json()).resolves.toMatchObject({
      error: {
        code: 'grant_ambiguous',
        message: expect.stringContaining('matches 2 registered repository paths'),
      },
    });
  });
});
