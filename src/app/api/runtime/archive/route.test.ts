import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const stateMocks = vi.hoisted(() => ({
  codex: vi.fn(),
  cursor: vi.fn(),
  gemini: vi.fn(),
  grok: vi.fn(),
  opencode: vi.fn(),
  getLane: vi.fn(),
  archiveLane: vi.fn(),
}));

vi.mock('@/lib/codex/owned', () => ({
  archiveOwnedCodexSession: vi.fn(),
  ownedCodexSessionState: stateMocks.codex,
}));
vi.mock('@/lib/cursor/owned', () => ({ ownedCursorSessionState: stateMocks.cursor }));
vi.mock('@/lib/gemini/owned', () => ({
  archiveOwnedGeminiSession: vi.fn(),
  ownedGeminiSessionState: stateMocks.gemini,
}));
vi.mock('@/lib/grok/owned', () => ({ ownedGrokSessionState: stateMocks.grok }));
vi.mock('@/lib/opencode/owned', () => ({
  archiveOwnedOpencodeSession: vi.fn(),
  ownedOpencodeSessionState: stateMocks.opencode,
}));
vi.mock('@/lib/lane/registry', () => ({
  getLane: stateMocks.getLane,
  archiveLane: stateMocks.archiveLane,
}));
vi.mock('@/lib/runtime/inventory', () => ({ invalidateRuntimeInventoryCache: vi.fn() }));

import { GET, POST } from './route';

function request(sessionKeys: string[]) {
  return new NextRequest(`http://localhost/api/runtime/archive?sessionKeys=${encodeURIComponent(sessionKeys.join(','))}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  stateMocks.codex.mockResolvedValue('active');
  stateMocks.cursor.mockResolvedValue('missing');
  stateMocks.gemini.mockResolvedValue('archived');
  stateMocks.grok.mockResolvedValue('active');
  stateMocks.opencode.mockResolvedValue('missing');
  stateMocks.getLane.mockReturnValue(null);
  stateMocks.archiveLane.mockReturnValue(null);
});

describe('GET /api/runtime/archive', () => {
  it('routes full owned keys by prefix, dedupes them, and fails open per key', async () => {
    const codexKey = 'codex-owned:codex-owned-1';
    const cursorKey = 'cursor-owned:cursor-owned-1';
    stateMocks.cursor.mockRejectedValue(new Error('uncertain filesystem'));

    const response = await GET(request([
      ` ${codexKey} `,
      'gemini-owned:gemini-owned-1',
      'opencode-owned:opencode-owned-1',
      cursorKey,
      'grok-owned:grok-owned-1',
      'unknown-owned:unknown-1',
      codexKey,
    ]));

    expect(await response.json()).toEqual({
      states: {
        [codexKey]: 'active',
        'gemini-owned:gemini-owned-1': 'archived',
        'opencode-owned:opencode-owned-1': 'missing',
        [cursorKey]: 'active',
        'grok-owned:grok-owned-1': 'active',
        'unknown-owned:unknown-1': 'active',
      },
    });
    expect(stateMocks.codex).toHaveBeenCalledOnce();
    expect(stateMocks.cursor).toHaveBeenCalledOnce();
  });

  it('caps the state lookup at 100 unique keys', async () => {
    const sessionKeys = Array.from({ length: 101 }, (_, index) => `codex-owned:codex-owned-${index}`);

    const response = await GET(request(sessionKeys));
    const body = await response.json() as { states: Record<string, string> };

    expect(Object.keys(body.states)).toHaveLength(100);
    expect(stateMocks.codex).toHaveBeenCalledTimes(100);
  });
});

describe('POST /api/runtime/archive', () => {
  it('archives a failed lane that never received a session key', async () => {
    const lane = {
      id: 'lane-sessionless',
      sessionKey: null,
      status: 'failed',
    };
    stateMocks.getLane.mockReturnValue(lane);
    stateMocks.archiveLane.mockReturnValue({ ...lane, status: 'archived' });

    const response = await POST(new NextRequest('http://localhost/api/runtime/archive', {
      method: 'POST',
      body: JSON.stringify({ laneId: lane.id }),
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      archived: true,
      laneId: lane.id,
    });
    expect(stateMocks.archiveLane).toHaveBeenCalledWith(lane.id, 'user');
  });

  it('refuses to hide a live sessionless lane', async () => {
    stateMocks.getLane.mockReturnValue({
      id: 'lane-running',
      sessionKey: null,
      status: 'running',
    });

    const response = await POST(new NextRequest('http://localhost/api/runtime/archive', {
      method: 'POST',
      body: JSON.stringify({ laneId: 'lane-running' }),
    }));

    expect(response.status).toBe(409);
    expect(stateMocks.archiveLane).not.toHaveBeenCalled();
  });
});
