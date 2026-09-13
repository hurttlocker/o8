// `o8 packet retry` recovery attestation (#2313) through the real command.
//
// The CLI is a supported control-plane entry point, so the flags that recover an
// interrupted reset/retry are exercised here end to end: the request body must
// preserve the ORIGINAL key, reason and verb, and carry the attestation beside
// them — never inside the body the key is bound to. Half an attestation, or one
// with a fresh key, must fail before a reset request is sent.
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CliError } from '../../api';
import { runPacketReset, runPacketRetry } from './recover';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-2313-cli-recovery-'));
const mode = { human: false, verbose: false };
const PACKET_ID = 'pkt-771614e0-cli';
const ORIGINAL_KEY = '5618eae7-cli';
const GENERATION = '82c0112c-cli';
const CANDIDATE_LANE = 'lane-f470ce31-cli';

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** The real command resolves its target through /api/lanes first. */
function routedFetch(): ReturnType<typeof vi.fn> {
  return vi.fn().mockImplementation((url: unknown) => {
    if (String(url).includes('/api/lanes')) {
      return Promise.resolve(jsonResponse({
        lanes: [{ id: CANDIDATE_LANE, packetId: PACKET_ID, status: 'paused', worktreePath: '/tmp/o8-2313-cli' }],
      }));
    }
    return Promise.resolve(jsonResponse({
      ok: true,
      result: { reset: false, salvaged: true, laneId: 'lane-review', note: 'salvaged', replayed: true },
    }));
  });
}

function resetCall(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.find((call) => String(call[0]).includes('/api/orchestrator/reset-packet'));
}

function postedBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return JSON.parse(String(resetCall(fetchMock)?.[1]?.body)) as Record<string, unknown>;
}

beforeEach(() => {
  process.env.CORTEX_IDE_DATA_DIR = dataDir;
  process.env.O8_API_PORT = '47199';
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('o8 packet retry recovery attestation (#2313)', () => {
  it('sends both attestations beside the original key and body', async () => {
    const fetchMock = routedFetch();
    vi.stubGlobal('fetch', fetchMock);

    await expect(runPacketRetry(mode, [
      '--packet', PACKET_ID,
      '--reason', 'Preserve committed roadmap candidate',
      '--idempotency-key', ORIGINAL_KEY,
      '--expected-generation', GENERATION,
      '--expected-candidate-lane', CANDIDATE_LANE,
    ])).resolves.toBe(0);

    expect(resetCall(fetchMock)).toBeDefined();
    expect(postedBody(fetchMock)).toEqual({
      packetId: PACKET_ID,
      clearWorktree: false,
      reason: 'Preserve committed roadmap candidate',
      idempotencyKey: ORIGINAL_KEY,
      recovery: { expectedGeneration: GENERATION, expectedCandidateLaneId: CANDIDATE_LANE },
    });
  });

  it('omits the attestation entirely for an ordinary retry', async () => {
    const fetchMock = routedFetch();
    vi.stubGlobal('fetch', fetchMock);

    await expect(runPacketRetry(mode, ['--packet', PACKET_ID, '--idempotency-key', ORIGINAL_KEY]))
      .resolves.toBe(0);

    expect(postedBody(fetchMock)).not.toHaveProperty('recovery');
  });

  it.each([
    ['only the generation', ['--expected-generation', GENERATION]],
    ['only the candidate lane', ['--expected-candidate-lane', CANDIDATE_LANE]],
    ['empty evidence values', ['--expected-generation=', '--expected-candidate-lane=']],
    ['whitespace evidence values', ['--expected-generation', '  ', '--expected-candidate-lane', '  ']],
    ['an empty generation flag', ['--expected-generation=']],
    ['an empty candidate flag', ['--expected-candidate-lane=']],
  ])('refuses %s before sending a reset request', async (label, flags) => {
    const fetchMock = routedFetch();
    vi.stubGlobal('fetch', fetchMock);

    await expect(runPacketRetry(mode, ['--packet', PACKET_ID, '--idempotency-key', ORIGINAL_KEY, ...flags]))
      .rejects.toMatchObject({ code: 'invalid_recovery_evidence' });
    expect(resetCall(fetchMock)).toBeUndefined();
  });

  it('refuses attestation on a worktree-clearing reset', async () => {
    const fetchMock = routedFetch();
    vi.stubGlobal('fetch', fetchMock);

    await expect(runPacketReset(mode, [
      '--packet', PACKET_ID,
      '--idempotency-key', ORIGINAL_KEY,
      '--expected-generation', GENERATION,
      '--expected-candidate-lane', CANDIDATE_LANE,
    ])).rejects.toMatchObject({ code: 'invalid_recovery_evidence' });
    expect(resetCall(fetchMock)).toBeUndefined();
  });

  it('refuses recovery evidence without the original key', async () => {
    const fetchMock = routedFetch();
    vi.stubGlobal('fetch', fetchMock);

    const pending = runPacketRetry(mode, [
      '--packet', PACKET_ID,
      '--expected-generation', GENERATION,
      '--expected-candidate-lane', CANDIDATE_LANE,
    ]);

    await expect(pending).rejects.toBeInstanceOf(CliError);
    await expect(pending).rejects.toMatchObject({ code: 'invalid_recovery_evidence' });
    expect(resetCall(fetchMock)).toBeUndefined();
  });
});
