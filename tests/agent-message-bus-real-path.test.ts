import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import type { AgentMessageDeliverySeams } from '@/lib/agents/delivery';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-agent-message-bus-'));
const OPERATOR_TOKEN = 'agent-message-operator-token-0123456789';
const SPECTATOR_TOKEN = 'agent-message-spectator-token-0123456789';
writeFileSync(join(dataDir, 'ws-token'), `${OPERATOR_TOKEN}\n`, 'utf8');
writeFileSync(
  join(dataDir, 'broadcast-spectator-tokens'),
  `${createHash('sha256').update(SPECTATOR_TOKEN).digest('hex')}\n`,
  'utf8',
);
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { createLane } = await import('@/lib/lane/registry');
const { mintPacketWorkerToken } = await import('@/lib/auth/packet-worker-token');
const { codename } = await import('@/lib/agents/codename');
const { closeDb, getSqlite } = await import('@/lib/db');
const heartbeatRoute = await import('@/app/api/lanes/[id]/heartbeat/route');
const presenceRoute = await import('@/app/api/agents/presence/route');
const inboxRoute = await import('@/app/api/agents/inbox/route');
const messageRoute = await import('@/app/api/agents/message/route');
const { createAgentMessagePostHandler } = await import('@/lib/agents/message-route-handler');
const broadcastEventsRoute = await import('@/app/api/broadcast/events/route');
const { panelGateMiddleware } = await import('@/middleware');

function request(
  url: string,
  input: { token: string; method?: string; body?: unknown },
): NextRequest {
  return new NextRequest(url, {
    method: input.method ?? 'GET',
    headers: {
      host: 'localhost:3001',
      authorization: `Bearer ${input.token}`,
      ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });
}

describe('agent message bus real path', () => {
  const repoPath = `/tmp/o8-agent-message-repo-${Date.now()}`;
  const packetId = `packet-agent-message-${Date.now()}`;
  const lane = createLane({
    label: 'Agent message sender',
    repoPath,
    worktreePath: `${repoPath}/.worktrees/sender`,
    branch: 'issue/agent-message-sender',
    baseBranch: 'main',
    runtime: 'codex',
    packetId,
  });
  const workerToken = mintPacketWorkerToken(packetId);
  const sendClaude = vi.fn<AgentMessageDeliverySeams['sendClaude']>().mockResolvedValue(undefined);
  const sendCodex = vi.fn<AgentMessageDeliverySeams['sendCodex']>().mockResolvedValue(undefined);
  const noLiveSessions = {
    discoverSessions: async () => [],
    resolveRepoPath: async () => null,
    now: () => new Date(),
  };
  const postMessage = createAgentMessagePostHandler({ sendClaude, sendCodex }, noLiveSessions);

  beforeEach(() => {
    sendClaude.mockClear();
    sendCodex.mockClear();
  });

  it('heartbeats presence, authorizes principals, delivers a user-role turn, cursors inbox, and mirrors Broadcast', async () => {
    const heartbeatRequest = request(`http://localhost:3001/api/lanes/${lane.id}/heartbeat`, {
      token: workerToken,
      method: 'POST',
      body: { heartbeatAt: Date.now() },
    });
    expect(panelGateMiddleware(heartbeatRequest).status).toBe(200);
    const heartbeat = await heartbeatRoute.POST(heartbeatRequest, { params: Promise.resolve({ id: lane.id }) });
    expect(heartbeat.status).toBe(200);

    const join = await presenceRoute.POST(request('http://localhost:3001/api/agents/presence', {
      token: OPERATOR_TOKEN,
      method: 'POST',
      body: {
        agentId: 'receiver-session',
        name: 'Receiver',
        repo: repoPath,
        worktreePath: `${repoPath}/.worktrees/receiver`,
        runtime: 'claude-code',
        sessionKey: 'claude-session-receiver',
      },
    }));
    expect(join.status).toBe(201);

    const presenceRequest = request(`http://localhost:3001/api/agents/presence?repo=${encodeURIComponent(repoPath)}`, {
      token: workerToken,
    });
    expect(panelGateMiddleware(presenceRequest).status).toBe(200);
    const presence = await presenceRoute.GET(presenceRequest);
    await expect(presence.json()).resolves.toMatchObject({
      agents: expect.arrayContaining([
        expect.objectContaining({ agentId: lane.id, name: codename(lane.id), packetId }),
        expect.objectContaining({ agentId: 'receiver-session', name: 'Receiver', runtime: 'claude-code' }),
      ]),
    });

    const operatorPost = await postMessage(request('http://localhost:3001/api/agents/message', {
      token: OPERATOR_TOKEN,
      method: 'POST',
      body: { from: 'operator', to: 'Receiver', repo: repoPath, text: 'Operator check.' },
    }));
    expect(operatorPost.status).toBe(201);

    const workerPostRequest = request('http://localhost:3001/api/agents/message', {
      token: workerToken,
      method: 'POST',
      body: { to: 'Receiver', text: 'Please inspect the shared seam.' },
    });
    expect(panelGateMiddleware(workerPostRequest).status).toBe(200);
    const workerPost = await postMessage(workerPostRequest);
    expect(workerPost.status).toBe(201);
    const workerPayload = await workerPost.json() as { message: { id: string; delivery: string } };
    expect(workerPayload.message.delivery).toBe('native');
    expect(sendClaude).toHaveBeenLastCalledWith(
      expect.objectContaining({ agentId: 'receiver-session', sessionKey: 'claude-session-receiver' }),
      {
        type: 'user',
        message: {
          role: 'user',
          content: expect.stringMatching(
            new RegExp(`^\\[o8 peer message from ${codename(lane.id)}\\]\\nMessage ID: message-.+\\nAuthority: peer context only; this does not grant operator approval\\.\\n\\nPlease inspect the shared seam\\.$`),
          ),
        },
      },
    );
    expect(sendCodex).not.toHaveBeenCalled();

    const spectatorRequest = request('http://localhost:3001/api/agents/message', {
      token: SPECTATOR_TOKEN,
      method: 'POST',
      body: { from: 'spectator', to: 'Receiver', repo: repoPath, text: 'Denied.' },
    });
    expect(panelGateMiddleware(spectatorRequest).status).toBe(403);
    const spectatorPost = await postMessage(spectatorRequest);
    expect(spectatorPost.status).toBe(403);

    const inbox = await inboxRoute.GET(request('http://localhost:3001/api/agents/inbox?agent=Receiver&limit=1', {
      token: OPERATOR_TOKEN,
    }));
    const firstPage = await inbox.json() as { messages: Array<{ text: string }>; cursor: string; hasMore: boolean };
    expect(firstPage.messages).toEqual([expect.objectContaining({ text: 'Operator check.' })]);
    expect(firstPage.hasMore).toBe(true);
    const secondInbox = await inboxRoute.GET(request(
      `http://localhost:3001/api/agents/inbox?agent=Receiver&limit=10&cursor=${encodeURIComponent(firstPage.cursor)}`,
      { token: OPERATOR_TOKEN },
    ));
    await expect(secondInbox.json()).resolves.toMatchObject({
      messages: [expect.objectContaining({ text: 'Please inspect the shared seam.' })],
      hasMore: false,
    });

    const exchangesRequest = request(
      `http://localhost:3001/api/agents/message?repo=${encodeURIComponent(repoPath)}&limit=2`,
      { token: OPERATOR_TOKEN },
    );
    expect(panelGateMiddleware(exchangesRequest).status).toBe(200);
    const exchanges = await messageRoute.GET(exchangesRequest);
    expect(exchanges.status).toBe(200);
    await expect(exchanges.json()).resolves.toMatchObject({
      schema: 'o8/agents.exchanges/v1',
      repo: repoPath,
      messages: [
        expect.objectContaining({
          from: codename(lane.id),
          to: 'Receiver',
          text: 'Please inspect the shared seam.',
          delivery: 'native',
          deliveryNote: 'Submitted to the exact live Claude terminal session.',
        }),
        expect.objectContaining({ from: 'operator', to: 'Receiver', text: 'Operator check.' }),
      ],
    });

    const workerExchanges = await messageRoute.GET(request(
      `http://localhost:3001/api/agents/message?repo=${encodeURIComponent(repoPath)}`,
      { token: workerToken },
    ));
    expect(workerExchanges.status).toBe(403);
    await expect(workerExchanges.json()).resolves.toMatchObject({
      error: { code: 'agent_exchanges_forbidden' },
    });

    const broadcast = await broadcastEventsRoute.GET(request(
      `http://localhost:3001/api/broadcast/events?limit=100&repo=${encodeURIComponent(repoPath)}&kinds=conversation`,
      { token: OPERATOR_TOKEN },
    ));
    const broadcastPage = await broadcast.json() as {
      events: Array<{ kind: string; detail: string; payload: Record<string, unknown> }>;
    };
    expect(broadcastPage.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'conversation',
        detail: 'Please inspect the shared seam.',
        payload: expect.objectContaining({ agentMessageId: workerPayload.message.id }),
      }),
    ]));
  });

  it('accepts the full 4,000-character contract and routes Codex targets through the active-task seam', async () => {
    const join = await presenceRoute.POST(request('http://localhost:3001/api/agents/presence', {
      token: OPERATOR_TOKEN,
      method: 'POST',
      body: {
        agentId: 'codex-receiver-session',
        name: 'CodexReceiver',
        repo: repoPath,
        worktreePath: `${repoPath}/.worktrees/codex-receiver`,
        runtime: 'codex',
        sessionKey: 'codex-thread-receiver',
      },
    }));
    expect(join.status).toBe(201);

    const text = 'm'.repeat(4_000);
    const accepted = await postMessage(request('http://localhost:3001/api/agents/message', {
      token: OPERATOR_TOKEN,
      method: 'POST',
      body: { from: 'operator', to: 'CodexReceiver', repo: repoPath, text },
    }));
    expect(accepted.status).toBe(201);
    await expect(accepted.json()).resolves.toMatchObject({
      message: {
        delivery: 'poll',
        deliveryNote: 'Codex inbox wake accepted; retained in the durable inbox until the target reads it.',
      },
    });
    expect(sendCodex).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'codex-receiver-session', sessionKey: 'codex-thread-receiver' }),
      expect.stringContaining('[o8 agent inbox]'),
    );
    expect(sendCodex.mock.calls[0]?.[1]).not.toContain(text);

    const rejected = await postMessage(request('http://localhost:3001/api/agents/message', {
      token: OPERATOR_TOKEN,
      method: 'POST',
      body: { from: 'operator', to: 'CodexReceiver', repo: repoPath, text: 'm'.repeat(4_001) },
    }));
    expect(rejected.status).toBe(400);
  });

  it('coalesces Codex wakes and remembers inbox progress when the cursor flag is omitted', async () => {
    const agentId = 'codex-coalesced-session';
    const name = 'CodexCoalescedReceiver';
    const joined = await presenceRoute.POST(request('http://localhost:3001/api/agents/presence', {
      token: OPERATOR_TOKEN,
      method: 'POST',
      body: {
        agentId,
        name,
        repo: repoPath,
        worktreePath: repoPath,
        runtime: 'codex',
        sessionKey: 'codex:coalesced-receiver',
      },
    }));
    expect(joined.status).toBe(201);

    const legacyNative = await postMessage(request('http://localhost:3001/api/agents/message', {
      token: OPERATOR_TOKEN,
      method: 'POST',
      body: { from: 'operator', to: name, repo: repoPath, text: 'Already submitted as a native turn.' },
    }));
    const legacyPayload = await legacyNative.json() as { message: { id: string } };
    getSqlite().prepare(`
      UPDATE agent_messages
      SET delivery_status = 'native', delivery_note = 'Accepted by the legacy per-message queue.'
      WHERE id = ?
    `).run(legacyPayload.message.id);

    for (const text of ['First update.', 'Second update.', 'Final current state.']) {
      const accepted = await postMessage(request('http://localhost:3001/api/agents/message', {
        token: OPERATOR_TOKEN,
        method: 'POST',
        body: { from: 'operator', to: name, repo: repoPath, text },
      }));
      expect(accepted.status).toBe(201);
      await expect(accepted.json()).resolves.toMatchObject({
        message: {
          delivery: 'poll',
          deliveryNote: expect.stringContaining('durable inbox'),
        },
      });
    }

    expect(sendCodex).toHaveBeenCalledTimes(1);
    expect(sendCodex).toHaveBeenCalledWith(
      expect.objectContaining({ agentId, sessionKey: 'codex:coalesced-receiver' }),
      expect.stringContaining('[o8 agent inbox]'),
    );
    expect(sendCodex.mock.calls[0]?.[1]).not.toContain('First update.');

    closeDb();
    const firstInbox = await inboxRoute.GET(request(
      `http://localhost:3001/api/agents/inbox?agentId=${encodeURIComponent(agentId)}&limit=2`,
      { token: OPERATOR_TOKEN },
    ));
    const firstPage = await firstInbox.json() as { messages: Array<{ text: string }>; hasMore: boolean };
    expect(firstPage.messages.map((message) => message.text)).toEqual([
      'First update.',
      'Second update.',
    ]);
    expect(firstPage.hasMore).toBe(true);

    const secondInbox = await inboxRoute.GET(request(
      `http://localhost:3001/api/agents/inbox?agentId=${encodeURIComponent(agentId)}&limit=100`,
      { token: OPERATOR_TOKEN },
    ));
    const secondPage = await secondInbox.json() as { messages: Array<{ text: string }>; hasMore: boolean };
    expect(secondPage.messages.map((message) => message.text)).toEqual([
      'Final current state.',
    ]);
    expect(secondPage.hasMore).toBe(false);

    const resumedInbox = await inboxRoute.GET(request(
      `http://localhost:3001/api/agents/inbox?agentId=${encodeURIComponent(agentId)}&limit=100`,
      { token: OPERATOR_TOKEN },
    ));
    await expect(resumedInbox.json()).resolves.toMatchObject({ messages: [], hasMore: false });

    const nextMessage = await postMessage(request('http://localhost:3001/api/agents/message', {
      token: OPERATOR_TOKEN,
      method: 'POST',
      body: { from: 'operator', to: name, repo: repoPath, text: 'New after acknowledgement.' },
    }));
    expect(nextMessage.status).toBe(201);
    expect(sendCodex).toHaveBeenCalledTimes(2);

    getSqlite().prepare(`
      UPDATE agent_inbox_state
      SET native_wake_at = '2000-01-01T00:00:00.000Z'
      WHERE repo_path = ? AND agent_name = ? COLLATE NOCASE
    `).run(repoPath, name);
    const recoveredWake = await postMessage(request('http://localhost:3001/api/agents/message', {
      token: OPERATOR_TOKEN,
      method: 'POST',
      body: { from: 'operator', to: name, repo: repoPath, text: 'Recover an abandoned wake.' },
    }));
    expect(recoveredWake.status).toBe(201);
    expect(sendCodex).toHaveBeenCalledTimes(3);
  });

  it('keeps a deferred native attempt queued, then marks it delivered when the target reads its inbox', async () => {
    const joined = await presenceRoute.POST(request('http://localhost:3001/api/agents/presence', {
      token: OPERATOR_TOKEN,
      method: 'POST',
      body: {
        agentId: 'codex-deferred-session',
        name: 'DeferredReceiver',
        repo: repoPath,
        worktreePath: repoPath,
        runtime: 'codex',
        sessionKey: 'codex:deferred-receiver',
      },
    }));
    expect(joined.status).toBe(201);

    const deferredPost = createAgentMessagePostHandler({
      sendClaude,
      sendCodex: async () => {
        throw new Error('The task already has an active writer.');
      },
    }, noLiveSessions);
    const accepted = await deferredPost(request('http://localhost:3001/api/agents/message', {
      token: OPERATOR_TOKEN,
      method: 'POST',
      body: {
        from: 'operator',
        to: 'DeferredReceiver',
        repo: repoPath,
        text: 'Read me from the durable fallback.',
      },
    }));
    expect(accepted.status).toBe(201);
    const acceptedPayload = await accepted.json() as {
      message: { id: string; delivery: string; deliveryNote: string };
    };
    expect(acceptedPayload).toMatchObject({
      message: {
        delivery: 'poll',
        deliveryNote: expect.stringContaining('retained in the durable inbox'),
      },
    });

    getSqlite().prepare(`
      UPDATE agent_messages
      SET delivery_status = 'failed', delivery_note = 'Legacy native delivery attempt failed.'
      WHERE id = ?
    `).run(acceptedPayload.message.id);
    const reconciled = await messageRoute.GET(request(
      `http://localhost:3001/api/agents/message?repo=${encodeURIComponent(repoPath)}&limit=20`,
      { token: OPERATOR_TOKEN },
    ));
    await expect(reconciled.json()).resolves.toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({
          id: acceptedPayload.message.id,
          delivery: 'poll',
        }),
      ]),
    });

    const inbox = await inboxRoute.GET(request(
      'http://localhost:3001/api/agents/inbox?agentId=codex-deferred-session&limit=100',
      { token: OPERATOR_TOKEN },
    ));
    expect(inbox.status).toBe(200);
    await expect(inbox.json()).resolves.toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({
          text: 'Read me from the durable fallback.',
          delivery: 'native',
          deliveryNote: 'Read from the durable inbox by the target session.',
        }),
      ]),
    });

    const exchanges = await messageRoute.GET(request(
      `http://localhost:3001/api/agents/message?repo=${encodeURIComponent(repoPath)}&limit=20`,
      { token: OPERATOR_TOKEN },
    ));
    await expect(exchanges.json()).resolves.toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({
          text: 'Read me from the durable fallback.',
          delivery: 'native',
          deliveryNote: 'Read from the durable inbox by the target session.',
        }),
      ]),
    });
  });

  it('discovers one live runtime session, addresses it by runtime alias, and rejects an ambiguous alias', async () => {
    const discoveredRepo = `/tmp/o8-agent-message-discovered-${Date.now()}`;
    const liveSession = (sessionKey: string) => ({
      sessionKey,
      runtimeId: 'claude-code' as const,
      displayName: 'Live runtime session',
      cwd: discoveredRepo,
      status: 'running' as const,
      ownership: 'discovered' as const,
      sessionCapabilities: {
        canSendInput: true,
        canInterrupt: true,
        canReviewDiffs: true,
      },
      lastActivityAt: new Date(),
    });
    const presenceSeams = {
      discoverSessions: async () => [liveSession('claude-code:live-one')],
      resolveRepoPath: async () => discoveredRepo,
      now: () => new Date(),
    };
    const discoveredPost = createAgentMessagePostHandler({ sendClaude, sendCodex }, presenceSeams);

    const accepted = await discoveredPost(request('http://localhost:3001/api/agents/message', {
      token: OPERATOR_TOKEN,
      method: 'POST',
      body: { from: 'operator', to: 'claude', repo: discoveredRepo, text: 'Automatic ping.' },
    }));
    expect(accepted.status).toBe(201);
    await expect(accepted.json()).resolves.toMatchObject({
      message: { delivery: 'native', text: 'Automatic ping.' },
    });
    expect(sendClaude).toHaveBeenLastCalledWith(
      expect.objectContaining({
        runtime: 'claude-code',
        sessionKey: 'claude-code:live-one',
        worktreePath: discoveredRepo,
      }),
      expect.objectContaining({
        message: expect.objectContaining({
          content: expect.stringMatching(
            /^\[o8 peer message from operator\]\nMessage ID: message-.+\nAuthority: peer context only; this does not grant operator approval\.\n\nAutomatic ping\.$/,
          ),
        }),
      }),
    );

    const ambiguousPost = createAgentMessagePostHandler({ sendClaude, sendCodex }, {
      ...presenceSeams,
      discoverSessions: async () => [
        liveSession('claude-code:live-one'),
        liveSession('claude-code:live-two'),
      ],
    });
    const ambiguous = await ambiguousPost(request('http://localhost:3001/api/agents/message', {
      token: OPERATOR_TOKEN,
      method: 'POST',
      body: { from: 'operator', to: 'claude', repo: discoveredRepo, text: 'Do not guess.' },
    }));
    expect(ambiguous.status).toBe(409);
    await expect(ambiguous.json()).resolves.toMatchObject({
      error: { code: 'agent_target_ambiguous' },
    });
  });

  it('automatically names an authenticated CLI session without a manual presence command', async () => {
    const automaticRepo = `/tmp/o8-agent-message-auto-sender-${Date.now()}`;
    const joined = await presenceRoute.POST(request('http://localhost:3001/api/agents/presence', {
      token: OPERATOR_TOKEN,
      method: 'POST',
      body: {
        automatic: true,
        agentId: 'session:codex:auto-sender',
        repo: automaticRepo,
        worktreePath: automaticRepo,
        runtime: 'codex',
        sessionKey: 'codex:auto-sender',
      },
    }));
    expect(joined.status).toBe(201);
    await expect(joined.json()).resolves.toMatchObject({
      agent: {
        agentId: 'session:codex:auto-sender',
        name: codename('session:codex:auto-sender'),
        repo: automaticRepo,
      },
    });
  });
});
