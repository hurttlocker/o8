import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  store: {
    getOrCreateTurn: vi.fn(),
    getConversation: vi.fn(),
    beginExecution: vi.fn(),
    appendConversation: vi.fn(),
    complete: vi.fn(),
    fail: vi.fn(),
  },
  readPlanner: vi.fn(),
  pollTurn: vi.fn(),
  loadSession: vi.fn(),
  createSession: vi.fn(),
  appendTranscript: vi.fn(),
}));

vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: () => null }));
vi.mock('@/lib/symon/managed-messages-store', () => ({
  getManagedSymonMessagesStore: () => h.store,
}));
vi.mock('@/lib/mobile/symon-text-bridge-client', () => ({
  readSymonTextPlannerInfo: h.readPlanner,
  pollSymonTextTurn: h.pollTurn,
}));
vi.mock('@/lib/mobile/symon-text-session-store', () => ({
  loadSymonTextSession: h.loadSession,
  createSymonTextSessionFromTranscript: h.createSession,
  appendSymonTextTranscript: h.appendTranscript,
  formatSymonTextPlannerPrompt: (_session: unknown, text: string) => `User: ${text}`,
}));

import { POST } from './route';

const baseTurn = {
  eventId: 'event-1',
  conversationId: 'chat-1',
  providerMessageId: 'message-1',
  senderHandle: '+12675550111',
  recipientHandle: '+12545550111',
  requestText: 'What is running?',
  turnId: 'managed-turn-1',
  sessionId: null,
  promptText: null,
  executionEpoch: null,
  status: 'queued',
  responseText: null,
  detail: null,
  createdAt: 1,
  updatedAt: 1,
};

const session = {
  subject: 'operator',
  deviceId: null,
  sessionId: 'session-1',
  engine: 'codex',
  model: 'gpt-5.6-sol',
  effort: 'high',
  workspaceMode: 'o8',
  repoId: null,
  repoPath: null,
  allowedTools: [],
  createdAt: 1,
  lastActivityAt: 1,
  transcript: [],
  activeMachine: { id: 'imac', displayName: 'iMac' },
};

function request() {
  return new NextRequest('http://localhost/api/symon/managed-messages/inbound', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      eventId: baseTurn.eventId,
      conversationId: baseTurn.conversationId,
      messageId: baseTurn.providerMessageId,
      sender: baseTurn.senderHandle,
      recipient: baseTurn.recipientHandle,
      text: baseTurn.requestText,
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.store.getOrCreateTurn.mockReturnValue({ ...baseTurn });
  h.store.getConversation.mockReturnValue({ sessionId: null, transcript: [] });
  h.readPlanner.mockResolvedValue({
    available: true,
    engine: session.engine,
    model: session.model,
    effort: session.effort,
    tools: [],
  });
  h.createSession.mockReturnValue(session);
  h.loadSession.mockReturnValue(session);
  h.store.beginExecution.mockImplementation((input: Record<string, unknown>) => ({
    ...baseTurn,
    status: 'processing',
    sessionId: input.sessionId,
    promptText: input.promptText,
    executionEpoch: input.executionEpoch,
  }));
});

describe('managed Symon Messages real route', () => {
  it('returns a persisted terminal result without running the CLI twice', async () => {
    h.store.getOrCreateTurn.mockReturnValue({
      ...baseTurn,
      status: 'completed',
      responseText: 'All clear.',
    });
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, state: 'done', text: 'All clear.' });
    expect(h.pollTurn).not.toHaveBeenCalled();
  });

  it('surfaces only approval state while the native card owns the decision', async () => {
    h.pollTurn.mockResolvedValue({
      state: 'needs_confirmation',
      confirmation: { tool: 'term_send', args: { text: 'private command' } },
    });
    const response = await POST(request());
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true, state: 'awaiting_approval' });
    expect(h.store.beginExecution).toHaveBeenCalledTimes(1);
    expect(h.store.appendConversation).toHaveBeenCalledWith(expect.objectContaining({
      entries: [{ role: 'user', text: baseTurn.requestText }],
    }));
  });

  it('fails closed across an app restart instead of replaying an uncertain action', async () => {
    h.store.getOrCreateTurn.mockReturnValue({
      ...baseTurn,
      status: 'processing',
      sessionId: session.sessionId,
      promptText: 'User: What is running?',
      executionEpoch: 'old-process',
    });
    const response = await POST(request());
    const payload = await response.json() as { text: string };
    expect(response.status).toBe(200);
    expect(payload.text).toContain('stopped instead of risking the same action twice');
    expect(h.store.fail).toHaveBeenCalledOnce();
    expect(h.pollTurn).not.toHaveBeenCalled();
  });
});
