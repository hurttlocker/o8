/**
 * Circuit-breaker tests for the OpenRouter adapter (2026-06-11 brain perf
 * pass). The breaker exists because deterministic hard failures (401/402)
 * were being re-paid on every single ask — a drained credit balance burned a
 * doomed HTTP round-trip per question and silently demoted the pipeline to
 * the slow CLI tiers.
 */

import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The adapter's daily-cap check + spend ledger open the app SQLite DB on
// first use — point it at a throwaway dir so tests never touch ~/.o8.
process.env.CORTEX_IDE_DATA_DIR = mkdtempSync(join(os.tmpdir(), 'o8-qa-test-'));

import {
  callOpenRouter,
  isOpenRouterCircuitOpen,
  resetOpenRouterCircuit,
} from '@/lib/cortex/qa/llm/openrouter-adapter';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const okBody = { choices: [{ message: { content: 'OK' } }], model: 'test-model' };
const insufficientCredits = { error: { message: 'Insufficient credits', code: 402 } };

describe('openrouter-adapter circuit breaker', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    resetOpenRouterCircuit();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    process.env.OPENROUTER_API_KEY = 'sk-or-test-key';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetOpenRouterCircuit();
  });

  it('starts closed', () => {
    expect(isOpenRouterCircuitOpen()).toBe(false);
  });

  it('opens after two consecutive 402s and skips fetch while open', async () => {
    fetchMock.mockResolvedValue(jsonResponse(402, insufficientCredits));

    await expect(callOpenRouter('q1')).rejects.toThrow('HTTP 402');
    expect(isOpenRouterCircuitOpen()).toBe(false);

    await expect(callOpenRouter('q2')).rejects.toThrow('HTTP 402');
    expect(isOpenRouterCircuitOpen()).toBe(true);

    // Third call must fail fast WITHOUT another network round-trip.
    await expect(callOpenRouter('q3')).rejects.toThrow('circuit open');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a success between hard failures resets the consecutive count', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(402, insufficientCredits))
      .mockResolvedValueOnce(jsonResponse(200, okBody))
      .mockResolvedValueOnce(jsonResponse(402, insufficientCredits));

    await expect(callOpenRouter('q1')).rejects.toThrow('HTTP 402');
    await expect(callOpenRouter('q2')).resolves.toBe('OK');
    await expect(callOpenRouter('q3')).rejects.toThrow('HTTP 402');

    // Only one consecutive failure since the success — still closed.
    expect(isOpenRouterCircuitOpen()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not trip on transient 5xx failures', async () => {
    fetchMock.mockResolvedValue(jsonResponse(503, { error: { message: 'upstream busy' } }));

    await expect(callOpenRouter('q1')).rejects.toThrow('HTTP 503');
    await expect(callOpenRouter('q2')).rejects.toThrow('HTTP 503');
    await expect(callOpenRouter('q3')).rejects.toThrow('HTTP 503');

    expect(isOpenRouterCircuitOpen()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('trips on 401 (bad key) the same as 402', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { error: { message: 'bad key' } }));

    await expect(callOpenRouter('q1')).rejects.toThrow('HTTP 401');
    await expect(callOpenRouter('q2')).rejects.toThrow('HTTP 401');

    expect(isOpenRouterCircuitOpen()).toBe(true);
  });
});
