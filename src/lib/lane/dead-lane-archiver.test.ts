/**
 * Unified dead-lane archiver — policy table (pure decision) + real-path archive.
 *
 * The policy table (DEAD_LANE_ARCHIVE_POLICY) replaced two divergent archivers
 * (reaper's archiveStaleDeadLanes @ 15m no-session, silent-exit's
 * archiveTerminallyDeadLanes @ 30m dead-label). This suite pins:
 *   - the pure decision for every status × condition × threshold row;
 *   - the documented threshold change (recovering no-session 15m → 30m) through
 *     the REAL archiveDeadLanes against persisted rows;
 *   - the structural wedge-before-archive ordering through the REAL
 *     runDeadLaneSweep (a packet-bound recovering lane escalates to the
 *     orchestrator instead of being archived out from under its packet).
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import type { Lane, LaneStatus } from './types';

process.env.O8_DATA_DIR = mkdtempSync(join(tmpdir(), 'o8-dead-lane-archiver-'));
// Empty owned root so any owned-session re-probe resolves "dead".
process.env.CORTEX_IDE_OWNED_CODEX_ROOT = mkdtempSync(join(tmpdir(), 'o8-dead-lane-owned-'));
process.env.O8_OWNED_QWEN_ROOT = mkdtempSync(join(tmpdir(), 'o8-dead-lane-qwen-'));

const {
  DEAD_LANE_ARCHIVE_POLICY,
  archiveDeadLanes,
  matchDeadLaneArchiveRule,
  runDeadLaneSweep,
} = await import('./dead-lane-archiver');
const { WEDGE_RECOVERING_MS } = await import('./wedge-timeouts');
const { createLane, deleteLane, getLane, updateLane } = await import('./registry');

const NOW = Date.parse('2026-07-08T12:00:00.000Z');
const MIN = 60_000;
const createdLaneIds: string[] = [];

function fakeLane(status: LaneStatus, overrides: Partial<Lane> = {}): Lane {
  const base: Lane = {
    id: `lane-fake-${Math.random().toString(36).slice(2, 8)}`,
    projectId: null,
    label: 'fake lane',
    repoPath: '/tmp/o8-archiver-fake',
    worktreePath: null,
    branch: 'inline/archiver',
    baseBranch: 'main',
    runtime: 'codex',
    sessionKey: null,
    packetId: null,
    prNumber: null,
    status,
    ownership: 'managed',
    writerToken: null,
    lastHeartbeatAt: null,
    createdAt: new Date(NOW - 100 * MIN).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    lastEventAt: new Date(NOW).toISOString(),
    lastEventLabel: null,
  };
  return { ...base, ...overrides };
}

function aged(status: LaneStatus, ageMs: number, overrides: Partial<Lane> = {}): Lane {
  return fakeLane(status, { lastEventAt: new Date(NOW - ageMs).toISOString(), ...overrides });
}

afterEach(() => {
  while (createdLaneIds.length > 0) deleteLane(createdLaneIds.pop()!);
});

afterAll(() => {
  if (process.env.O8_DATA_DIR) rmSync(process.env.O8_DATA_DIR, { recursive: true, force: true });
  if (process.env.CORTEX_IDE_OWNED_CODEX_ROOT) rmSync(process.env.CORTEX_IDE_OWNED_CODEX_ROOT, { recursive: true, force: true });
  if (process.env.O8_OWNED_QWEN_ROOT) rmSync(process.env.O8_OWNED_QWEN_ROOT, { recursive: true, force: true });
  if (process.env.O8_OWNED_QWEN_ROOT) rmSync(`${process.env.O8_OWNED_QWEN_ROOT}-archive`, { recursive: true, force: true });
});

describe('matchDeadLaneArchiveRule (policy table — pure decision)', () => {
  const cases: Array<{ name: string; lane: Lane; expected: string | null }> = [
    { name: 'paused + no session past 15m → phantom_paused_no_session', lane: aged('paused', 16 * MIN), expected: 'phantom_paused_no_session' },
    { name: 'paused + no session under 15m → null', lane: aged('paused', 14 * MIN), expected: null },
    { name: 'paused WITH a session → null (no_session condition fails)', lane: aged('paused', 60 * MIN, { sessionKey: 'codex-owned:x' }), expected: null },
    // THRESHOLD CHANGE: recovering no-session moved 15m → 30m.
    { name: 'recovering + no session past 15m → null (raised to 30m; old 15m would fire)', lane: aged('recovering', 16 * MIN, { lastEventLabel: 'session_lost' }), expected: null },
    { name: 'recovering + no session past 30m → phantom_recovering_no_session', lane: aged('recovering', 31 * MIN, { lastEventLabel: 'session_lost' }), expected: 'phantom_recovering_no_session' },
    { name: 'recovering WITH a session → null', lane: aged('recovering', 60 * MIN, { sessionKey: 'codex-owned:x' }), expected: null },
    { name: 'reviewing + dead label past 30m → terminally_dead_label', lane: aged('reviewing', 31 * MIN, { lastEventLabel: 'zombie_reap' }), expected: 'terminally_dead_label' },
    { name: 'reviewing + dead label under 30m → null', lane: aged('reviewing', 29 * MIN, { lastEventLabel: 'zombie_reap' }), expected: null },
    { name: 'reviewing + work-present label (NOT dead) → null', lane: aged('reviewing', 120 * MIN, { lastEventLabel: 'silent_exit_work_present' }), expected: null },
    { name: 'reviewing + no session, no dead label → null (reviewing is not a no_session status)', lane: aged('reviewing', 120 * MIN), expected: null },
    { name: 'recovering + dead label + no session past 30m → dead-label rule wins (first in table, gets re-probe)', lane: aged('recovering', 31 * MIN, { lastEventLabel: 'zombie_reap' }), expected: 'terminally_dead_label' },
    { name: 'awaiting_input + silent_exit_no_work past 30m → terminally_dead_label', lane: aged('awaiting_input', 31 * MIN, { lastEventLabel: 'silent_exit_no_work' }), expected: 'terminally_dead_label' },
    { name: 'running is never archivable', lane: aged('running', 120 * MIN, { lastEventLabel: 'zombie_reap' }), expected: null },
    { name: 'dead-label rule requires a timestamp (missing lastEventAt → skip)', lane: fakeLane('reviewing', { lastEventLabel: 'zombie_reap', lastEventAt: null }), expected: null },
  ];

  for (const { name, lane, expected } of cases) {
    it(name, () => {
      expect(matchDeadLaneArchiveRule(lane, NOW)?.id ?? null).toBe(expected);
    });
  }

  it('every rule id is unique', () => {
    const ids = DEAD_LANE_ARCHIVE_POLICY.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

function persistLane(status: LaneStatus, ageMs: number, opts: {
  packetId?: string;
  sessionKey?: string | null;
  label?: string;
  runtime?: Lane['runtime'];
} = {}) {
  const lane = createLane({
    repoPath: '/tmp/o8-archiver-real',
    branch: `inline/archiver-${Math.random().toString(36).slice(2, 8)}`,
    baseBranch: 'main',
    runtime: opts.runtime ?? 'codex',
    packetId: opts.packetId,
  });
  createdLaneIds.push(lane.id);
  const patched = updateLane(
    lane.id,
    {
      status,
      sessionKey: opts.sessionKey ?? null,
      lastEventAt: new Date(Date.now() - ageMs).toISOString(),
      lastEventLabel: opts.label ?? status,
    },
    'system',
  );
  return patched ?? lane;
}

describe('archiveDeadLanes (real path through the registry)', () => {
  it('leaves a recovering no-session lane at 20m but archives it at 35m (threshold raised 15m→30m)', async () => {
    const lane = persistLane('recovering', 20 * MIN, { label: 'session_lost' });

    await archiveDeadLanes(Date.now());
    expect(getLane(lane.id)?.status).toBe('recovering'); // old 15m rule would have archived here

    updateLane(lane.id, { lastEventAt: new Date(Date.now() - 35 * MIN).toISOString() }, 'system');
    await archiveDeadLanes(Date.now());
    expect(getLane(lane.id)?.status).toBe('archived');
  });

  it('archives a reviewing + zombie_reap lane past 30m (dead-label rule, re-probe passes for a dead session)', async () => {
    const lane = persistLane('reviewing', 35 * MIN, { label: 'zombie_reap' });
    await archiveDeadLanes(Date.now());
    expect(getLane(lane.id)?.status).toBe('archived');
  });

  it('never archives a work-present reviewing lane even after hours', async () => {
    const lane = persistLane('reviewing', 180 * MIN, { label: 'silent_exit_work_present' });
    await archiveDeadLanes(Date.now());
    expect(getLane(lane.id)?.status).toBe('reviewing');
  });

  it('archives a dead declarative session before retiring its lane', async () => {
    const sessionKey = `qwen-owned:dead-sweep-${Date.now()}`;
    const sessionId = sessionKey.slice(sessionKey.indexOf(':') + 1);
    const sessionDir = join(process.env.O8_OWNED_QWEN_ROOT!, sessionId);
    mkdirSync(join(sessionDir, 'runs'), { recursive: true });
    const timestamp = new Date(Date.now() - 35 * MIN).toISOString();
    writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({
      surfaceId: sessionKey,
      sessionDir,
      cwd: process.cwd(),
      repoPath: process.cwd(),
      title: 'Dead sweep fixture',
      createdAt: timestamp,
      updatedAt: timestamp,
      latestPrompt: 'dead sweep',
      latestSummary: 'dead sweep',
      recentRuns: [],
    }));
    const lane = persistLane('reviewing', 35 * MIN, {
      label: 'zombie_reap',
      runtime: 'qwen',
      sessionKey,
    });

    await archiveDeadLanes(Date.now());

    expect(getLane(lane.id)?.status).toBe('archived');
    expect(existsSync(sessionDir)).toBe(false);
    expect(existsSync(join(`${process.env.O8_OWNED_QWEN_ROOT!}-archive`, sessionId))).toBe(true);
  });

  it('keeps the lane visible when its owned session archive is unconfirmed', async () => {
    const sessionKey = `qwen-owned:dead-sweep-conflict-${Date.now()}`;
    const sessionId = sessionKey.slice(sessionKey.indexOf(':') + 1);
    const sessionDir = join(process.env.O8_OWNED_QWEN_ROOT!, sessionId);
    const archiveDir = join(`${process.env.O8_OWNED_QWEN_ROOT!}-archive`, sessionId);
    mkdirSync(join(sessionDir, 'runs'), { recursive: true });
    mkdirSync(archiveDir, { recursive: true });
    const timestamp = new Date(Date.now() - 35 * MIN).toISOString();
    writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({
      surfaceId: sessionKey,
      sessionDir,
      cwd: process.cwd(),
      repoPath: process.cwd(),
      title: 'Dead sweep conflict fixture',
      createdAt: timestamp,
      updatedAt: timestamp,
      latestPrompt: 'dead sweep conflict',
      latestSummary: 'dead sweep conflict',
      recentRuns: [],
    }));
    const lane = persistLane('reviewing', 35 * MIN, {
      label: 'zombie_reap',
      runtime: 'qwen',
      sessionKey,
    });

    await archiveDeadLanes(Date.now());

    expect(getLane(lane.id)?.status).toBe('reviewing');
    expect(existsSync(sessionDir)).toBe(true);
  });
});

describe('runDeadLaneSweep (structural wedge-before-archive ordering)', () => {
  it('escalates a packet-bound recovering lane to the orchestrator instead of archiving it out from under the packet', async () => {
    // Aged past BOTH the 15m wedge AND the 30m archive: archive-first would bury
    // it; wedge-first (structural) escalates it to awaiting_orchestrator, which is
    // not an archivable status, so the archive pass leaves it.
    const lane = persistLane('recovering', WEDGE_RECOVERING_MS + 20 * MIN, {
      packetId: `pkt-sweep-${Date.now()}`,
      label: 'zombie_reap',
    });

    await runDeadLaneSweep(Date.now());

    const after = getLane(lane.id);
    expect(after?.status).toBe('awaiting_orchestrator');
  });
});
