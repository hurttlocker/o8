// @vitest-environment jsdom
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'o8-peer-transcript-identity-'));
const token = 'peer-transcript-fixture-operator-0123456789';
writeFileSync(join(dataDir, 'ws-token'), token);
vi.stubEnv('O8_DATA_DIR', dataDir);
vi.stubEnv('CORTEX_IDE_DATA_DIR', dataDir);

// The production peer-message hook and transcript renderer stay connected.
// Runtime transcript loading and unrelated transform controls are isolated.
const emptyTranscript = { messages: [], status: 'fresh', error: null };
vi.mock('@/lib/transcripts/useTranscript', () => ({ useTranscript: () => emptyTranscript }));
vi.mock('@/components/desktop/workspace-terminal/use-packet-transcript-poll', () => ({ usePacketTranscriptPoll: () => ({ entries: [], activity: null }) }));
vi.mock('@/components/desktop/workspace-terminal/SessionTransformMenu', () => ({ SessionTransformMenu: () => null }));

const { closeDb, getSqlite } = await import('@/lib/db');
afterAll(() => { closeDb(); vi.unstubAllEnvs(); rmSync(dataDir, { recursive: true, force: true }); });
const presenceRoute = await import('@/app/api/agents/presence/route');
const messageRoute = await import('@/app/api/agents/message/route');
const { createAgentMessagePostHandler } = await import('@/lib/agents/message-route-handler');
const { AgentTilePane } = await import('@/components/desktop/workspace-terminal/AgentTilePane');

const post = createAgentMessagePostHandler({ sendClaude: async () => {}, sendCodex: async () => true }, {
  discoverSessions: async () => [], resolveRepoPath: async () => null, now: () => new Date(),
});
function request(path: string, body?: unknown) {
  return new NextRequest(new URL(path, 'http://localhost'), {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const path = String(input);
    if (path.startsWith('/api/agents/presence')) return presenceRoute.GET(request(path));
    if (path.startsWith('/api/agents/message')) return messageRoute.GET(request(path));
    throw new Error(`Unexpected transcript request: ${path}`);
  }));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function settled(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  expect(check()).toBe(true);
}

it.each(['codex', 'claude-code'] as const)('keeps the %s replacement pane bound to persisted send-time identities', async runtime => {
  const repo = join(dataDir, `repo-${runtime}`); mkdirSync(repo);
  const targetId = `target-${runtime}`; const peerId = `peer-${runtime}`;
  const original = `${runtime}-owned:original`; const replacement = `${runtime}-owned:replacement`;
  const joinTarget = (sessionKey: string) => presenceRoute.POST(request('/api/agents/presence', {
    agentId: targetId, name: 'Cedar', repo, worktreePath: repo, runtime, sessionKey,
  }));
  expect((await joinTarget(original)).status).toBe(201);
  expect((await presenceRoute.POST(request('/api/agents/presence', {
    agentId: peerId, name: 'Pine', repo, worktreePath: repo, runtime, sessionKey: `${runtime}-owned:peer`,
  }))).status).toBe(201);
  const send = async (fromAgentId: string, to: string, text: string) => {
    const response = await post(request('/api/agents/message', { repo, fromAgentId, to, text }));
    expect(response.status).toBe(201);
    return (await response.json()).message as { id: string };
  };
  const oldIncoming = await send(peerId, 'Cedar', 'Original incoming');
  const oldOutgoing = await send(targetId, 'Pine', 'Original outgoing');
  getSqlite().prepare('UPDATE agent_presence SET last_seen = ? WHERE agent_id = ?')
    .run('2000-01-01T00:00:00.000Z', targetId);
  expect((await joinTarget(replacement)).status).toBe(200);
  const newIncoming = await send(peerId, 'Cedar', 'Replacement incoming');
  const newOutgoing = await send(targetId, 'Pine', 'Replacement outgoing');
  closeDb();
  const history = await messageRoute.GET(request(`/api/agents/message?repo=${encodeURIComponent(repo)}`));
  const { messages } = await history.json() as { messages: Array<{ id: string; refs: { identities: { from: unknown; to: unknown } } }> };
  expect(messages).toHaveLength(4);
  expect(messages.find(message => message.id === oldIncoming.id)?.refs.identities.to).toEqual({ runtime, sessionKey: original });
  expect(messages.find(message => message.id === oldOutgoing.id)?.refs.identities.from).toEqual({ runtime, sessionKey: original });
  const pane = (label: string, sessionKey: string) => createElement('section', { 'aria-label': label }, createElement(AgentTilePane, {
    sessionKey, agent: null, focused: true, onClose: vi.fn(), onFocus: vi.fn(),
  }));
  await act(async () => root.render(createElement('div', null, pane('Replacement', replacement), pane('Counterpart', `${runtime}-owned:peer`))));
  const replacementPane = host.querySelector('[aria-label="Replacement"]')!;
  const counterpartPane = host.querySelector('[aria-label="Counterpart"]')!;
  await settled(() => Boolean(replacementPane.querySelector(`[data-agent-peer-message-id="${newIncoming.id}"]`)
    && counterpartPane.querySelector(`[data-agent-peer-message-id="${newIncoming.id}"]`)));
  const ids = [...replacementPane.querySelectorAll('[data-agent-peer-message-id]')].map(node => node.getAttribute('data-agent-peer-message-id'));
  expect(ids).toHaveLength(2);
  expect(ids).toEqual(expect.arrayContaining([newIncoming.id, newOutgoing.id]));
  expect(replacementPane.textContent).not.toContain('Original incoming');
  expect(replacementPane.textContent).not.toContain('Original outgoing');
  expect(replacementPane.textContent).toContain('Replacement incoming'); expect(replacementPane.textContent).toContain('Replacement outgoing');
  expect(replacementPane.querySelector(`[data-agent-peer-message-id="${newIncoming.id}"]`)?.textContent).toContain('From Pine');
  expect(replacementPane.querySelector(`[data-agent-peer-message-id="${newOutgoing.id}"]`)?.textContent).toContain('To Pine');
  expect([...counterpartPane.querySelectorAll('[data-agent-peer-message-id]')].map(node => node.getAttribute('data-agent-peer-message-id')))
    .toEqual(expect.arrayContaining([oldIncoming.id, oldOutgoing.id, newIncoming.id, newOutgoing.id]));
});
