import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, describe, expect, it } from 'vitest';
import { archiveRootForOwnedSessionRoot } from '@/lib/runtimes/shared/owned-session/archive';

const root = mkdtempSync(path.join(tmpdir(), 'o8-runtime-archive-real-'));
const piRoot = path.join(root, 'owned-pi');
const piArchiveRoot = path.join(root, 'owned-pi-archive');
const qwenRoot = path.join(root, 'owned-qwen');
process.env.O8_DATA_DIR = root;
process.env.CORTEX_IDE_DATA_DIR = root;
process.env.O8_OWNED_PI_ROOT = piRoot;
process.env.O8_OWNED_PI_ARCHIVE_ROOT = piArchiveRoot;
process.env.O8_OWNED_QWEN_ROOT = qwenRoot;

const { GET, POST } = await import('@/app/api/runtime/archive/route');

function writeSession(sessionRoot: string, surfaceId: string): void {
  const id = surfaceId.slice(surfaceId.indexOf(':') + 1);
  const sessionDir = path.join(sessionRoot, id);
  mkdirSync(path.join(sessionDir, 'runs'), { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify({
    surfaceId,
    sessionDir,
    cwd: process.cwd(),
    repoPath: process.cwd(),
    title: 'Archive route fixture',
    createdAt: now,
    updatedAt: now,
    latestPrompt: 'archive fixture',
    latestSummary: 'archive fixture',
    recentRuns: [],
  }));
}

function getRequest(sessionKeys: string[]): NextRequest {
  return new NextRequest(`http://localhost/api/runtime/archive?sessionKeys=${encodeURIComponent(sessionKeys.join(','))}`);
}

function postRequest(sessionKey: string, clientMutationId: string): NextRequest {
  return new NextRequest('http://localhost/api/runtime/archive', {
    method: 'POST',
    body: JSON.stringify({ sessionKey, clientMutationId }),
  });
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('runtime archive generic owned-session route', () => {
  it.each([
    ['pi-owned:pi-route-fixture', piRoot],
    ['qwen-owned:qwen-route-fixture', qwenRoot],
  ] as const)('reports and archives %s through the real route and store', async (sessionKey, sessionRoot) => {
    writeSession(sessionRoot, sessionKey);

    const before = await GET(getRequest([sessionKey]));
    expect(await before.json()).toEqual({ states: { [sessionKey]: 'active' } });

    const archived = await POST(postRequest(sessionKey, `archive-${sessionKey}`));
    expect(archived.status).toBe(200);
    expect(await archived.json()).toMatchObject({ ok: true, archived: true });

    const after = await GET(getRequest([sessionKey]));
    expect(await after.json()).toEqual({ states: { [sessionKey]: 'archived' } });
  });

  it('returns conflict and keeps the active row when a generic archive cannot be confirmed', async () => {
    const sessionKey = 'qwen-owned:qwen-route-conflict';
    writeSession(qwenRoot, sessionKey);
    const sessionId = sessionKey.slice(sessionKey.indexOf(':') + 1);
    mkdirSync(path.join(archiveRootForOwnedSessionRoot(qwenRoot), sessionId), { recursive: true });

    const response = await POST(postRequest(sessionKey, 'archive-conflict-result'));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, archived: false });
    const state = await GET(getRequest([sessionKey]));
    expect(await state.json()).toEqual({ states: { [sessionKey]: 'active' } });
  });

  it('replays the persisted receipt after the first response is lost without archiving twice', async () => {
    const sessionKey = 'qwen-owned:qwen-route-lost-response';
    const clientMutationId = 'archive-lost-response-replay';
    writeSession(qwenRoot, sessionKey);

    await POST(postRequest(sessionKey, clientMutationId));
    const replay = await POST(postRequest(sessionKey, clientMutationId));

    expect(replay.status).toBe(200);
    expect(replay.headers.get('x-o8-idempotency-replayed')).toBe('1');
    await expect(replay.json()).resolves.toMatchObject({
      ok: true,
      archived: true,
      sessionKey,
      clientMutationId,
      replayed: true,
    });
    const state = await GET(getRequest([sessionKey]));
    expect(await state.json()).toEqual({ states: { [sessionKey]: 'archived' } });
  });

  it('rejects changed archive input bound to a completed mutation id', async () => {
    const firstSessionKey = 'qwen-owned:qwen-route-binding-first';
    const changedSessionKey = 'qwen-owned:qwen-route-binding-changed';
    const clientMutationId = 'archive-changed-body-conflict';
    writeSession(qwenRoot, firstSessionKey);
    writeSession(qwenRoot, changedSessionKey);

    expect((await POST(postRequest(firstSessionKey, clientMutationId))).status).toBe(200);
    const conflict = await POST(postRequest(changedSessionKey, clientMutationId));

    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      error: expect.stringContaining('different runtime archive'),
    });
    const state = await GET(getRequest([changedSessionKey]));
    expect(await state.json()).toEqual({ states: { [changedSessionKey]: 'active' } });
  });
});
