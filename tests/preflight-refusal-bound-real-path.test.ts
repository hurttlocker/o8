/**
 * #2195 — a packet refused by dispatch preflight must stop retrying, and must
 * say why.
 *
 * The loop is a two-module handshake, which is why either half alone stays
 * green while the bug runs. `scheduling.ts` writes `status: 'blocked'` on a
 * refusal; `reconcileOrchestratorMissionState` re-derives packet status FROM
 * THE LANE, and a packet refused at preflight never got one — so the
 * no-lane fall-through wrote `queued` back and nulled `blockedReason` on the
 * very next headless tick. Measured live: ~15 refusals a minute, 1,186 log
 * lines, an auth probe spawned per pass, and no operator-visible handle on the
 * packet at all.
 *
 * So the assertions below drive the REAL pair in the REAL order the headless
 * loop runs them — runDispatchTick -> reconcile -> repeat — and require the
 * terminal state to SURVIVE the reconcile. Asserting only that the scheduler
 * wrote something would pass against the original bug.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const preflight = vi.hoisted(() => ({
  calls: 0,
  detail: 'The selected runtime has no credential evidence.',
}));

vi.mock('@/lib/runtimes/shared/auth-detect', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runtimes/shared/auth-detect')>();
  return {
    ...actual,
    // Stands in for a preflight that refuses every time for an unchanged
    // reason. The call counter is the probe proxy: each real invocation is what
    // spawned the auth-probe subprocess on the demo machine.
    assertRuntimeDispatchable: vi.fn(async (runtime: string) => {
      preflight.calls += 1;
      throw new actual.DispatchPreflightError({
        house: 'opencode',
        runtime: runtime as never,
        installed: true,
        ready: false,
        authenticated: false,
        unavailableReason: 'needs_auth',
        detail: preflight.detail,
        fix: 'Sign in to the runtime, then reset the packet.',
        checkedAt: Date.now(),
      });
    }),
  };
});

vi.mock('@/lib/runtime/actions', () => ({
  launchRuntimeSurface: vi.fn(async () => {
    throw new Error('preflight must refuse before any launch is attempted');
  }),
}));

const { createEmptyOrchestratorMissionState, reconcileOrchestratorMissionState } =
  await import('@/lib/orchestrator/store');
const { runDispatchTick, getDispatchBlocker, MAX_PREFLIGHT_REFUSALS } =
  await import('@/lib/orchestrator/scheduling');
import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';

const testRoot = mkdtempSync(join(tmpdir(), 'o8-preflight-refusal-bound-'));
const repoPath = join(testRoot, 'repo');

beforeAll(() => {
  mkdirSync(repoPath, { recursive: true });
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repoPath });
  writeFileSync(join(repoPath, 'README.md'), 'preflight refusal bound\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repoPath });
  execFileSync('git', [
    '-c', 'user.email=test@o8.local',
    '-c', 'user.name=o8-test',
    'commit', '-m', 'init',
  ], { cwd: repoPath });
});

beforeEach(() => {
  preflight.calls = 0;
});

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

function refusedPacket(): OrchestratorPacket {
  return {
    id: 'pkt-preflight-refused-2195',
    referenceLabel: 'PKT-PREFLIGHT-2195',
    title: 'packet the preflight always refuses',
    summary: 'packet the preflight always refuses',
    workspaceTargetPath: repoPath,
    branchTarget: 'issue/2195-preflight-refusal',
    runtime: 'opencode',
    dependencyLabels: [],
    dependencyPacketIds: [],
    queueState: 'queued',
    releaseState: 'pending',
    status: 'queued',
    blockedReason: null,
    lane: null,
  };
}

function stateWith(packet: OrchestratorPacket): OrchestratorMissionState {
  return { ...createEmptyOrchestratorMissionState(), packets: [packet] };
}

/** One turn of the headless loop: dispatch, then re-derive from lane truth. */
async function headlessTick(state: OrchestratorMissionState): Promise<OrchestratorMissionState> {
  const dispatched = await runDispatchTick(state);
  return reconcileOrchestratorMissionState(dispatched, {
    laneSnapshots: [],
    runtimeTruth: [],
  });
}

function only(state: OrchestratorMissionState): OrchestratorPacket {
  const packet = state.packets.find((candidate) => candidate.id === 'pkt-preflight-refused-2195');
  if (!packet) throw new Error('packet vanished from mission state');
  return packet;
}

describe('#2195 dispatch preflight refusals are bounded and visible', () => {
  it('reaches a terminal state that survives reconcile, and stops probing', async () => {
    let state = stateWith(refusedPacket());

    // Comfortably more turns than the budget: the pre-fix loop ran until it was
    // stopped by hand, so the bound has to hold against a scheduler that keeps
    // being asked.
    const turns = MAX_PREFLIGHT_REFUSALS * 4;
    const statusPerTurn: string[] = [];
    for (let turn = 0; turn < turns; turn += 1) {
      state = await headlessTick(state);
      statusPerTurn.push(only(state).status);
    }

    const packet = only(state);

    // 1. Terminal, and terminal AFTER reconcile re-derived it — the exact step
    //    that used to un-write 'blocked' back to 'queued'.
    expect(packet.status).toBe('failed');
    expect(packet.preflightRefusals).toBe(MAX_PREFLIGHT_REFUSALS);

    // 2. Visible, with the reason. This is what PacketCard renders; before the
    //    fix reconcile nulled it on every pass and the only evidence was a log.
    expect(packet.blockedReason).toContain(preflight.detail);
    expect(packet.blockedReason).toMatch(/preflight refused/i);

    // 3. Bounded probes. One per refusal, and not one per turn.
    expect(preflight.calls).toBe(MAX_PREFLIGHT_REFUSALS);
    expect(preflight.calls).toBeLessThan(turns);

    // 4. And no dispatch path will re-admit it. Checked a second time against a
    //    packet forced back to 'queued', because that is exactly the shape the
    //    bug produced: the count has to block on its own, without relying on a
    //    status that something else re-derived.
    expect(getDispatchBlocker(packet, state.packets)).not.toBeNull();
    expect(getDispatchBlocker(
      { ...packet, status: 'queued', blockedReason: null },
      state.packets,
    )).toMatch(/preflight refusals exceeded/i);

    // 5. Retries were real up to the budget — a runtime that is merely still
    //    starting must still get its attempts, so the fix must not be "refuse
    //    once, give up".
    expect(statusPerTurn.slice(0, MAX_PREFLIGHT_REFUSALS - 1)).toEqual(
      Array(MAX_PREFLIGHT_REFUSALS - 1).fill('queued'),
    );
  });

  it('keeps the terminal state and reason across further reconcile passes', async () => {
    let state = stateWith(refusedPacket());
    for (let turn = 0; turn < MAX_PREFLIGHT_REFUSALS; turn += 1) {
      state = await headlessTick(state);
    }
    expect(only(state).status).toBe('failed');
    const reason = only(state).blockedReason;

    // Reconcile alone, with no dispatch in between — the headless loop also
    // re-derives state on ticks that dispatch nothing.
    for (let pass = 0; pass < 5; pass += 1) {
      state = reconcileOrchestratorMissionState(state, { laneSnapshots: [], runtimeTruth: [] });
    }

    expect(only(state).status).toBe('failed');
    expect(only(state).blockedReason).toBe(reason);
    expect(preflight.calls).toBe(MAX_PREFLIGHT_REFUSALS);
  });
});
