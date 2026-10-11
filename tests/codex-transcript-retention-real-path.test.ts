import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, describe, expect, it } from 'vitest';

const root = mkdtempSync(path.join(tmpdir(), 'o8-external-transcript-retention-'));
const providerHome = path.join(root, 'provider');
const dataDir = path.join(root, 'data');
mkdirSync(dataDir, { recursive: true });
const operatorToken = 'retention-operator-fixture-0123456789abcdef';
writeFileSync(path.join(dataDir, 'ws-token'), operatorToken, { mode: 0o600 });
process.env.CODEX_HOME = providerHome;
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { POST } = await import('@/app/api/panel/codex-sessions/prune/route');
const { mintPacketWorkerToken, resolvePacketWorkerToken } = await import('@/lib/auth/packet-worker-token');

function request(body: unknown, token = operatorToken) {
  return new NextRequest('http://localhost/api/panel/codex-sessions/prune', {
    method: 'POST',
    headers: { host: 'localhost', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

afterAll(async () => {
  const { closeDb } = await import('@/lib/db');
  closeDb();
  rmSync(root, { recursive: true, force: true });
});

describe('external provider transcript retention through the real route', () => {
  it.each(['archive', 'delete'] as const)('holds %s without changing eligible external transcript bytes or identity', async (mode) => {
    const sessionDir = path.join(providerHome, 'sessions', mode);
    mkdirSync(sessionDir, { recursive: true });
    const transcript = path.join(sessionDir, 'rollout-fixture.jsonl');
    const bytes = `${JSON.stringify({ type: 'session_meta', payload: { id: `external-${mode}`, cwd: path.join(root, 'missing-workspace') } })}\n`;
    writeFileSync(transcript, bytes);
    const old = new Date(Date.now() - 30 * 24 * 60 * 60_000);
    utimesSync(transcript, old, old);
    const before = statSync(transcript);

    const result = await POST(request({ mode, maxAgeDays: 1 }));

    expect(result.status).toBe(409);
    await expect(result.json()).resolves.toMatchObject({
      ok: false,
      code: 'unsupported_external_transcript_retention',
      held: true,
      capabilities: { archive: false, purge: false },
    });
    expect(readFileSync(transcript, 'utf8')).toBe(bytes);
    const after = statSync(transcript);
    expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: before.dev, ino: before.ino });
  });

  it('rejects an unauthenticated caller before retention work', async () => {
    const result = await POST(request({ mode: 'delete' }, 'unknown-fixture-credential'));
    expect(result.status).toBe(403);
  });

  it('denies the actual persisted packet worker credential', async () => {
    const token = mintPacketWorkerToken('pkt-external-transcript-retention', { processMarker: 'retention-worker-fixture' });
    expect(resolvePacketWorkerToken(token)?.packetId).toBe('pkt-external-transcript-retention');

    const result = await POST(request({ mode: 'delete' }, token));

    expect(result.status).toBe(403);
  });

  it('keeps malformed options as an actionable validation error', async () => {
    const result = await POST(request({ mode: 'purge-everything' }));
    expect(result.status).toBe(400);
  });
});
