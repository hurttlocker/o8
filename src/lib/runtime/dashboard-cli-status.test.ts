import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeSession } from '@/lib/runtimes/types';
import { readCodexDashboardTurnEvidence } from './dashboard-cli-status';

const fixtures: string[] = [];
const session: RuntimeSession = {
  sessionKey: 'codex:verified-thread',
  runtimeId: 'codex',
  displayName: 'Codex',
  cwd: '/repo',
  status: 'running',
  ownership: 'discovered',
  pid: 4242,
  sessionCapabilities: { canSendInput: true, canInterrupt: true, canReviewDiffs: true },
  lastActivityAt: new Date('2026-09-24T12:00:00Z'),
};

function rollout(events: Array<{ timestamp: string; type: string; payload?: { type: string } }>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'o8-cli-turn-status-'));
  fixtures.push(dir);
  const file = path.join(dir, 'rollout.jsonl');
  writeFileSync(file, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  return file;
}

afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('verified dashboard Codex turn evidence', () => {
  it('uses recent structured turn events and never mistakes a live process for a working turn', async () => {
    const file = rollout([
      { timestamp: '2026-09-24T12:00:00Z', type: 'event_msg', payload: { type: 'task_started' } },
      { timestamp: '2026-09-24T12:00:10Z', type: 'response_item', payload: { type: 'message' } },
    ]);
    let now = new Date('2026-09-24T12:00:30Z');
    const read = () => readCodexDashboardTurnEvidence(session, {
      resolveRolloutPath: async () => file,
      now,
    });
    expect(await read()).toMatchObject({
      sessionId: session.sessionKey,
      state: 'working',
      authority: 'runtime-event',
      observedAt: '2026-09-24T12:00:10.000Z',
      evidence: expect.arrayContaining([{ source: 'codex-rollout.lifecycle', value: 'task_started' }]),
    });

    writeFileSync(file, `${JSON.stringify({ timestamp: '2026-09-24T12:00:40Z', type: 'event_msg', payload: { type: 'task_complete' } })}\n`, { flag: 'a' });
    now = new Date('2026-09-24T12:00:50Z');
    expect(await read()).toMatchObject({
      state: 'complete',
      authority: 'runtime-event',
      observedAt: '2026-09-24T12:00:40.000Z',
    });

    writeFileSync(file, `${JSON.stringify({ timestamp: '2026-09-24T12:01:00Z', type: 'event_msg', payload: { type: 'task_started' } })}\n`, { flag: 'a' });
    now = new Date('2026-09-24T12:01:30Z');
    expect(await read()).toMatchObject({ state: 'working', observedAt: '2026-09-24T12:01:00.000Z' });
  });

  it('falls back on stale activity, unavailable history, malformed rows, and unknown lifecycle boundaries', async () => {
    const file = rollout([
      { timestamp: '2026-09-24T12:00:00Z', type: 'event_msg', payload: { type: 'task_started' } },
    ]);
    const evidence = await readCodexDashboardTurnEvidence(session, {
      resolveRolloutPath: async () => file,
      now: new Date('2026-09-24T12:05:00Z'),
    });
    expect(evidence).toMatchObject({ state: 'unknown', authority: 'raw-terminal' });
    expect(evidence.fallbackReason).toContain('stale');

    expect(await readCodexDashboardTurnEvidence(session, {
      resolveRolloutPath: async () => null,
    })).toMatchObject({ state: 'unknown', authority: 'raw-terminal' });

    writeFileSync(file, '{broken}\n', { flag: 'a' });
    expect(await readCodexDashboardTurnEvidence(session, {
      resolveRolloutPath: async () => file,
      now: new Date('2026-09-24T12:00:30Z'),
    })).toMatchObject({ state: 'unknown', authority: 'raw-terminal' });

    writeFileSync(file, `${JSON.stringify({ timestamp: '2026-09-24T12:00:20Z', type: 'event_msg', payload: { type: 'task_paused' } })}\n`);
    expect(await readCodexDashboardTurnEvidence(session, {
      resolveRolloutPath: async () => file,
      now: new Date('2026-09-24T12:00:30Z'),
    })).toMatchObject({ state: 'unknown', authority: 'raw-terminal' });

    writeFileSync(file, `${JSON.stringify({ timestamp: '2026-09-24T12:00:20Z', type: 'event_msg', payload: { type: 'task_started' } })}\n{"type":"event_msg"`);
    expect(await readCodexDashboardTurnEvidence(session, {
      resolveRolloutPath: async () => file,
      now: new Date('2026-09-24T12:00:30Z'),
    })).toMatchObject({ state: 'unknown', authority: 'raw-terminal' });
  });

  it('bounds the tail read and declines to infer a turn from a truncated lifecycle', async () => {
    const file = rollout([
      { timestamp: '2026-09-24T12:00:00Z', type: 'event_msg', payload: { type: 'task_started' } },
    ]);
    writeFileSync(file, `${JSON.stringify({ timestamp: '2026-09-24T12:00:01Z', type: 'response_item', payload: { type: 'message', text: 'x'.repeat(300_000) } })}\n`, { flag: 'a' });
    expect(await readCodexDashboardTurnEvidence(session, {
      resolveRolloutPath: async () => file,
      now: new Date('2026-09-24T12:00:30Z'),
    })).toMatchObject({ state: 'unknown', authority: 'raw-terminal' });
  });
});
