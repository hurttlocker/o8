import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const askCortexMock = vi.hoisted(() => vi.fn());
const findLatestLaneByPacketMock = vi.hoisted(() => vi.fn());
const findMissionRegistryEntryByPacketIdMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/cortex/qa/ask', () => ({
  askCortex: askCortexMock,
}));

vi.mock('@/lib/lane/events', () => ({
  recordLaneEvent: vi.fn(),
}));

vi.mock('@/lib/lane/registry', () => ({
  findLatestLaneByPacket: findLatestLaneByPacketMock,
}));

vi.mock('@/lib/orchestrator/mission-registry', () => ({
  findMissionRegistryEntryByPacketId: findMissionRegistryEntryByPacketIdMock,
}));

const { POST } = await import('@/app/api/cortex/ask/answer/route');

function request(body: unknown): NextRequest {
  return new NextRequest('http://127.0.0.1/api/cortex/ask/answer', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('/api/cortex/ask/answer terse flag', () => {
  beforeEach(() => {
    askCortexMock.mockReset();
    findLatestLaneByPacketMock.mockReset();
    findMissionRegistryEntryByPacketIdMock.mockReset();
    askCortexMock.mockResolvedValue({
      answer: 'Use the packet guide. [CITATION:directive-seed]',
      citations: [{ kind: 'directive', rowId: 'directive-seed', table: 'directives' }],
      class: 'A',
      retrievalMs: 1,
      classifyMs: 2,
      sourcesConsidered: 3,
      consideredChars: 42,
    });
  });

  it('passes terse through to the ask pipeline', async () => {
    const res = await POST(request({
      question: 'What is the packet rule?',
      repoPath: '/repo/o8',
      projectId: 'proj-o8',
      terse: true,
    }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, answer: 'Use the packet guide. [CITATION:directive-seed]' });
    expect(askCortexMock).toHaveBeenCalledWith('What is the packet rule?', '/repo/o8', {
      bypassCache: false,
      projectId: 'proj-o8',
      terse: true,
    });
  });

  it('defaults terse to false when omitted', async () => {
    const res = await POST(request({ question: 'What is the packet rule?' }));

    expect(res.status).toBe(200);
    expect(askCortexMock).toHaveBeenCalledWith('What is the packet rule?', undefined, {
      bypassCache: false,
      projectId: null,
      terse: false,
    });
  });

  it('passes usage attribution when the caller supplies a packet', async () => {
    findLatestLaneByPacketMock.mockReturnValue({ id: 'lane-cost', repoPath: '/repo/o8' });
    findMissionRegistryEntryByPacketIdMock.mockReturnValue({ id: 'mission-cost' });

    const res = await POST(request({
      question: 'What is the packet rule?',
      packetId: 'packet-cost',
    }));

    expect(res.status).toBe(200);
    expect(askCortexMock).toHaveBeenCalledWith('What is the packet rule?', '/repo/o8', {
      bypassCache: false,
      projectId: null,
      terse: false,
      usageContext: {
        laneId: 'lane-cost',
        packetId: 'packet-cost',
        missionId: 'mission-cost',
      },
    });
  });
});
