import { afterEach, describe, expect, it, vi } from 'vitest';

import { runMission } from './mission';
import { EXIT } from '../api';

const mode = { human: false, verbose: false };

function missionResponse() {
  return {
    ok: true,
    result: {
      missionId: 'mission-effort-pin',
      packets: [{ id: 'pkt-effort-pin', title: 'effort pin', wave: 1 }],
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.O8_API_PORT;
});

describe('o8 mission create --effort', () => {
  it('carries a valid --effort pin into the create-mission request body', async () => {
    process.env.O8_API_PORT = '47120';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(missionResponse()), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(runMission(mode, 'create', [
      '--title', 'effort pin',
      '--repo', process.cwd(),
      '--runtime', 'codex',
      '--model', 'gpt-5.6-terra',
      '--effort', 'high',
    ])).resolves.toBe(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain('/api/orchestrator/create-mission');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.requestedEffort).toBe('high');
  });

  it('omits requestedEffort entirely when --effort is not passed (parity)', async () => {
    process.env.O8_API_PORT = '47120';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(missionResponse()), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(runMission(mode, 'create', [
      '--title', 'no effort pin',
      '--repo', process.cwd(),
      '--runtime', 'codex',
    ])).resolves.toBe(0);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty('requestedEffort');
  });

  it('rejects a malformed --effort before any request is sent', async () => {
    process.env.O8_API_PORT = '47120';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(runMission(mode, 'create', [
      '--title', 'bad effort pin',
      '--repo', process.cwd(),
      '--effort', 'turbo',
    ])).rejects.toMatchObject({ code: 'invalid_args', exit: EXIT.INVALID_ARGS });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a valueless --effort before any request is sent', async () => {
    process.env.O8_API_PORT = '47120';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(runMission(mode, 'create', [
      '--title', 'valueless effort pin',
      '--repo', process.cwd(),
      '--effort',
    ])).rejects.toMatchObject({ code: 'invalid_args', exit: EXIT.INVALID_ARGS });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects conflicting repeated --effort instead of first-flag-wins', async () => {
    process.env.O8_API_PORT = '47120';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(runMission(mode, 'create', [
      '--title', 'repeated effort pin',
      '--repo', process.cwd(),
      '--effort', 'high',
      '--effort', 'low',
    ])).rejects.toMatchObject({ code: 'invalid_args', exit: EXIT.INVALID_ARGS });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
