import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliUsageSnapshot } from '@/lib/usage/cli-scrape';

const homeFixture = vi.hoisted(() => ({ path: '' }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: () => homeFixture.path,
  };
});

const NOW_MS = Date.parse('2026-08-11T16:00:00.000Z');
const testHome = mkdtempSync(join(tmpdir(), 'o8-cli-usage-api-'));
homeFixture.path = testHome;

const cliUsageRoute = await import('@/app/api/panel/cli-usage/route');

function writeFixture(relativePath: string, content: string, mtimeMs: number) {
  const filePath = join(testHome, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf8');
  const modifiedAt = new Date(mtimeMs);
  utimesSync(filePath, modifiedAt, modifiedAt);
}

function writeCodexObservation(observedAtMs: number, usedPercent: unknown = 25) {
  writeFixture('.codex/sessions/2026/08/11/rollout.jsonl', `${JSON.stringify({
    timestamp: new Date(observedAtMs).toISOString(),
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        primary: {
          window_minutes: 300,
          used_percent: usedPercent,
          resets_at: Math.floor((NOW_MS + 60 * 60 * 1000) / 1000),
        },
        secondary: {
          window_minutes: 10080,
          used_percent: 40,
          resets_at: Math.floor((NOW_MS + 24 * 60 * 60 * 1000) / 1000),
        },
      },
    },
  })}\n`, observedAtMs);
}

function writeClaudeObservation(observedAtMs: number) {
  writeFixture('.claude/projects/project/session.jsonl', `${JSON.stringify({
    timestamp: new Date(observedAtMs).toISOString(),
    message: {
      usage: {
        input_tokens: 120,
        output_tokens: 30,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 900,
      },
    },
  })}\n`, observedAtMs);
}

async function readRoute(): Promise<CliUsageSnapshot> {
  const response = await cliUsageRoute.GET();
  expect(response.status).toBe(200);
  return await response.json() as CliUsageSnapshot;
}

beforeEach(() => {
  rmSync(join(testHome, '.codex'), { recursive: true, force: true });
  rmSync(join(testHome, '.claude'), { recursive: true, force: true });
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
});

afterAll(() => {
  vi.useRealTimers();
  rmSync(testHome, { recursive: true, force: true });
});

describe('CLI usage capacity API', () => {
  it('returns normalized capacity while retaining the drawer compatibility fields', async () => {
    const codexObservedAt = NOW_MS - 60_000;
    const claudeObservedAt = NOW_MS - 2 * 60_000;
    writeCodexObservation(codexObservedAt);
    writeClaudeObservation(claudeObservedAt);

    const body = await readRoute();

    expect(body.schema).toBe('o8/runtime-capacity/v1');
    expect(body.generatedAt).toBe(NOW_MS);
    expect(body.capacities).toEqual([
      expect.objectContaining({
        runtime: 'codex',
        identityId: null,
        status: 'available',
        reason: null,
        observedAt: new Date(codexObservedAt).toISOString(),
        source: 'structured-cli',
        confidence: 'exact',
        buckets: [
          expect.objectContaining({ id: 'primary', usedRatio: 0.25, remaining: null }),
          expect.objectContaining({ id: 'secondary', usedRatio: 0.4, remaining: null }),
        ],
      }),
      expect.objectContaining({
        runtime: 'claude-code',
        identityId: null,
        status: 'available',
        reason: null,
        observedAt: new Date(claudeObservedAt).toISOString(),
        source: 'local-state',
        confidence: 'estimated',
        buckets: [
          expect.objectContaining({ id: 'rolling-5h', usedRatio: null, remaining: null }),
          expect.objectContaining({ id: 'rolling-7d', usedRatio: null, remaining: null }),
        ],
      }),
    ]);
    expect(body.codex).toMatchObject({
      runtime: 'codex',
      available: true,
      source: 'structured-cli',
      primary: { usedPercent: 25, tokens: null },
    });
    expect(body.claude).toMatchObject({
      runtime: 'claude',
      available: true,
      source: 'local-state',
      primary: { usedPercent: null, tokens: 160 },
      secondary: { usedPercent: null, tokens: 160 },
    });
    expect(JSON.stringify(body)).not.toContain(testHome);
  });

  it('marks malformed provider observations without returning raw payloads or paths', async () => {
    writeCodexObservation(NOW_MS - 60_000, 'secret-raw-limit');
    writeFixture(
      '.claude/projects/project/session.jsonl',
      'secret-raw-transcript not-json',
      NOW_MS - 60_000,
    );

    const body = await readRoute();
    const serialized = JSON.stringify(body);

    expect(body.capacities.map((capacity) => ({
      runtime: capacity.runtime,
      status: capacity.status,
      reason: capacity.reason,
      observedAt: capacity.observedAt,
    }))).toEqual([
      { runtime: 'codex', status: 'malformed', reason: 'malformed_observation', observedAt: null },
      { runtime: 'claude-code', status: 'malformed', reason: 'malformed_observation', observedAt: null },
    ]);
    expect(body.codex).toMatchObject({ available: false, source: null });
    expect(body.claude).toMatchObject({ available: false, source: null });
    expect(serialized).not.toContain('secret-raw-limit');
    expect(serialized).not.toContain('secret-raw-transcript');
    expect(serialized).not.toContain(testHome);
  });

  it('distinguishes stale observations from unavailable capacity', async () => {
    const staleObservedAt = NOW_MS - 60 * 60 * 1000;
    writeCodexObservation(staleObservedAt);
    writeClaudeObservation(staleObservedAt);

    const stale = await readRoute();
    expect(stale.capacities.map((capacity) => ({
      runtime: capacity.runtime,
      status: capacity.status,
      reason: capacity.reason,
    }))).toEqual([
      { runtime: 'codex', status: 'stale', reason: 'observation_stale' },
      { runtime: 'claude-code', status: 'stale', reason: 'observation_stale' },
    ]);
    expect(stale.codex.available).toBe(true);
    expect(stale.claude.available).toBe(true);

    rmSync(join(testHome, '.codex'), { recursive: true, force: true });
    rmSync(join(testHome, '.claude'), { recursive: true, force: true });
    const unavailable = await readRoute();
    expect(unavailable.capacities.map((capacity) => ({
      runtime: capacity.runtime,
      status: capacity.status,
      reason: capacity.reason,
      identityId: capacity.identityId,
    }))).toEqual([
      { runtime: 'codex', status: 'unavailable', reason: 'local_state_missing', identityId: null },
      { runtime: 'claude-code', status: 'unavailable', reason: 'local_state_missing', identityId: null },
    ]);
    expect(unavailable.codex.available).toBe(false);
    expect(unavailable.claude.available).toBe(false);
  });
});
