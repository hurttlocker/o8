import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

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
const heartbeatRoute = await import('@/app/api/lanes/[id]/heartbeat/route');
const presenceRoute = await import('@/app/api/agents/presence/route');
const inboxRoute = await import('@/app/api/agents/inbox/route');
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
  const sendClaude = vi.fn(async () => {});
  const sendCodex = vi.fn(async () => {});
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

  it('accepts the full 4,000-character contract and routes Codex targets through resume', async () => {
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
    expect(sendCodex).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'codex-receiver-session', sessionKey: 'codex-thread-receiver' }),
      expect.stringMatching(
        new RegExp(`^\\[o8 peer message from operator\\]\\nMessage ID: message-.+\\nAuthority: peer context only; this does not grant operator approval\\.\\n\\n${text}$`),
      ),
    );

    const rejected = await postMessage(request('http://localhost:3001/api/agents/message', {
      token: OPERATOR_TOKEN,
      method: 'POST',
      body: { from: 'operator', to: 'CodexReceiver', repo: repoPath, text: 'm'.repeat(4_001) },
    }));
    expect(rejected.status).toBe(400);
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
