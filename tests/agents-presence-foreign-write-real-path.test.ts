import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-presence-foreign-write-'));
const operatorToken = 'presence-foreign-write-operator-token-0123456789';
writeFileSync(path.join(dataDir, 'ws-token'), `${operatorToken}\n`, 'utf8');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const presenceRoute = await import('@/app/api/agents/presence/route');
const { closeDb, getSqlite } = await import('@/lib/db');
const { AGENT_PRESENCE_TTL_MS, findAgentPresence } = await import('@/lib/agents/store');

function joinRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3001/api/agents/presence', {
    method: 'POST',
    headers: {
      host: 'localhost:3001',
      authorization: `Bearer ${operatorToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('agent presence foreign writes through the real route', () => {
  it('returns 409 and preserves the owner row when an agent id arrives with another session key', async () => {
    const agentId = 'shared-agent-id';
    const first = await presenceRoute.POST(joinRequest({
      agentId,
      name: 'Owner',
      repo: '/tmp/o8-presence-foreign-write-repo',
      worktreePath: '/tmp/o8-presence-foreign-write-repo/owner',
      runtime: 'codex',
      sessionKey: 'owner-session-key',
    }));
    expect(first.status).toBe(201);
    const before = findAgentPresence({ agentId });
    expect(before).toMatchObject({ name: 'Owner', sessionKey: 'owner-session-key' });

    const second = await presenceRoute.POST(joinRequest({
      agentId,
      name: 'Intruder',
      repo: '/tmp/o8-presence-foreign-write-repo',
      worktreePath: '/tmp/o8-presence-foreign-write-repo/intruder',
      runtime: 'codex',
      sessionKey: 'intruder-session-key',
    }));

    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toEqual({
      schema: 'o8/agents.presence.error/v1',
      ok: false,
      error: {
        code: 'foreign_identity',
        message: 'This status line is owned by @Owner (owner-session-key); your session is intruder-session-key.',
      },
    });
    expect(findAgentPresence({ agentId })).toEqual(before);
  });

  it('takes over an expired owner and records the new session key', async () => {
    const agentId = 'stale-agent-id';
    const first = await presenceRoute.POST(joinRequest({
      agentId,
      name: 'StaleOwner',
      repo: '/tmp/o8-presence-foreign-write-repo',
      worktreePath: '/tmp/o8-presence-foreign-write-repo/stale-owner',
      runtime: 'codex',
      sessionKey: 'stale-session-key',
    }));
    expect(first.status).toBe(201);
    const staleLastSeen = new Date(Date.now() - AGENT_PRESENCE_TTL_MS - 1_000).toISOString();
    getSqlite().prepare('UPDATE agent_presence SET last_seen = ? WHERE agent_id = ?')
      .run(staleLastSeen, agentId);

    const restarted = await presenceRoute.POST(joinRequest({
      agentId,
      name: 'RestartedWorker',
      repo: '/tmp/o8-presence-foreign-write-repo',
      worktreePath: '/tmp/o8-presence-foreign-write-repo/restarted-worker',
      runtime: 'codex',
      sessionKey: 'restarted-session-key',
    }));

    expect(restarted.status).toBe(200);
    await expect(restarted.json()).resolves.toMatchObject({
      ok: true,
      agent: {
        agentId,
        name: 'RestartedWorker',
        sessionKey: 'restarted-session-key',
        tookOverStale: true,
      },
    });
    expect(findAgentPresence({ agentId })).toMatchObject({
      name: 'RestartedWorker',
      sessionKey: 'restarted-session-key',
    });
  });

  it('adopts a legacy null session key once', async () => {
    const agentId = 'legacy-agent-id';
    const first = await presenceRoute.POST(joinRequest({
      agentId,
      name: 'LegacyOwner',
      repo: '/tmp/o8-presence-foreign-write-repo',
      worktreePath: '/tmp/o8-presence-foreign-write-repo/legacy-owner',
      runtime: 'codex',
    }));
    expect(first.status).toBe(201);
    expect(findAgentPresence({ agentId })).toMatchObject({ sessionKey: null });

    const adopted = await presenceRoute.POST(joinRequest({
      agentId,
      name: 'LegacyOwner',
      repo: '/tmp/o8-presence-foreign-write-repo',
      worktreePath: '/tmp/o8-presence-foreign-write-repo/legacy-owner',
      runtime: 'codex',
      sessionKey: 'adopted-session-key',
    }));

    expect(adopted.status).toBe(200);
    await expect(adopted.json()).resolves.toMatchObject({
      ok: true,
      agent: {
        agentId,
        sessionKey: 'adopted-session-key',
      },
    });
    const adoptedRow = findAgentPresence({ agentId });
    expect(adoptedRow).toMatchObject({ sessionKey: 'adopted-session-key' });

    const foreign = await presenceRoute.POST(joinRequest({
      agentId,
      name: 'LegacyOwner',
      repo: '/tmp/o8-presence-foreign-write-repo',
      worktreePath: '/tmp/o8-presence-foreign-write-repo/legacy-owner',
      runtime: 'codex',
      sessionKey: 'foreign-session-key',
    }));
    expect(foreign.status).toBe(409);
    expect(findAgentPresence({ agentId })).toEqual(adoptedRow);
  });
});
