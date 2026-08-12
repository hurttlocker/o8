import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  runtimeAction: vi.fn(),
  laneDispatch: vi.fn(),
  steerPacket: vi.fn(),
  resetPacket: vi.fn(),
  rerunWithFeedback: vi.fn(),
  approveAndMergePacket: vi.fn(),
  stopPacket: vi.fn(),
}));

vi.mock('@/lib/runtime/actions', () => ({ performRuntimeAction: h.runtimeAction }));
vi.mock('@/lib/lane/commands', () => ({ dispatch: h.laneDispatch }));
vi.mock('@/lib/orchestrator/operator-mission-service', () => ({
  steerPacket: h.steerPacket,
  resetPacket: h.resetPacket,
  rerunWithFeedback: h.rerunWithFeedback,
  approveAndMergePacket: h.approveAndMergePacket,
}));
vi.mock('@/lib/orchestrator/stop-packet', () => ({ stopPacket: h.stopPacket }));

import {
  performAgentControlAction,
  performLegacyRuntimeActionViaAgentControl,
} from './service';
import { SteerPacketUnavailableError } from '@/lib/orchestrator/operator-mission-service/steer';

describe('agent-control service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.runtimeAction.mockResolvedValue({
      ok: true,
      action: 'interrupt',
      surfaceId: 'codex-owned:s1',
      runtime: 'codex',
      status: 'completed',
      note: 'Interrupted.',
      aborted: true,
    });
    h.laneDispatch.mockResolvedValue({ ok: true, laneId: 'lane-1', note: 'Held.' });
    h.stopPacket.mockResolvedValue({
      ok: true,
      packetId: 'pkt-1',
      interruptedSessions: 1,
      archivedLanes: 1,
      worktreePruned: false,
      killConfirmed: true,
      note: 'Terminated and held.',
    });
    h.steerPacket.mockResolvedValue({
      packetId: 'pkt-1',
      laneId: 'lane-1',
      note: 'Steered.',
    });
  });

  it('keeps a session interrupt on the runtime surface', async () => {
    const result = await performAgentControlAction({
      ref: { kind: 'session', id: 'codex-owned:s1' },
      action: { kind: 'interrupt' },
    });

    expect(h.runtimeAction).toHaveBeenCalledWith(expect.objectContaining({
      action: 'interrupt',
      surfaceId: 'codex-owned:s1',
    }));
    expect(h.laneDispatch).not.toHaveBeenCalled();
    expect(h.stopPacket).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ref: { kind: 'session' },
      status: 'completed',
      aborted: true,
      target: {
        schema: 'o8/agent-control.target/v1',
        canonicalRef: { kind: 'session', id: 'codex-owned:s1' },
        resolution: 'runtime',
        runtime: 'codex',
        surfaceId: 'codex-owned:s1',
        sessionKey: 'codex-owned:s1',
      },
    });
  });

  it('maps a lane hold to the durable lane stop verb without terminating the packet facade', async () => {
    const result = await performAgentControlAction({
      ref: { kind: 'lane', id: 'lane-1' },
      action: { kind: 'hold' },
    });

    expect(h.laneDispatch).toHaveBeenCalledWith({ verb: 'stop', laneId: 'lane-1', actor: 'user' });
    expect(h.runtimeAction).not.toHaveBeenCalled();
    expect(h.stopPacket).not.toHaveBeenCalled();
    expect(result.status).toBe('held');
  });

  it('reports a carded lane hold as pending approval even when dispatch has not run it', async () => {
    h.laneDispatch.mockResolvedValueOnce({
      ok: false,
      laneId: 'lane-1',
      approvalId: 'approval-1',
      note: 'Approval required.',
    });

    const result = await performAgentControlAction({
      ref: { kind: 'lane', id: 'lane-1' },
      action: { kind: 'hold' },
    });

    expect(result).toMatchObject({
      ok: true,
      status: 'pending_approval',
      approvalId: 'approval-1',
    });
  });

  it('uses confirmed packet termination instead of lane interruption or reset', async () => {
    const result = await performAgentControlAction({
      ref: { kind: 'packet', id: 'pkt-1' },
      action: { kind: 'terminate' },
    });

    expect(h.stopPacket).toHaveBeenCalledWith('pkt-1');
    expect(h.resetPacket).not.toHaveBeenCalled();
    expect(h.laneDispatch).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'held', aborted: true });
  });

  it('keeps reset and retry distinct through clearWorktree', async () => {
    h.resetPacket.mockResolvedValue({ note: 'Reset.' });
    await performAgentControlAction({
      ref: { kind: 'packet', id: 'pkt-1' },
      action: { kind: 'reset', reason: 'clean' },
    });
    await performAgentControlAction({
      ref: { kind: 'packet', id: 'pkt-1' },
      action: { kind: 'retry', reason: 'again' },
    });

    expect(h.resetPacket).toHaveBeenNthCalledWith(1, {
      packetId: 'pkt-1',
      reason: 'clean',
      clearWorktree: true,
    });
    expect(h.resetPacket).toHaveBeenNthCalledWith(2, {
      packetId: 'pkt-1',
      reason: 'again',
      clearWorktree: false,
    });
  });

  it('reports a salvaged retry as review-ready instead of held', async () => {
    h.resetPacket.mockResolvedValue({
      reset: false,
      salvaged: true,
      laneId: 'lane-review',
      note: 'Committed work is awaiting review.',
    });

    const result = await performAgentControlAction({
      ref: { kind: 'packet', id: 'pkt-1' },
      action: { kind: 'retry' },
    });

    expect(result).toMatchObject({
      ok: true,
      status: 'completed',
      laneId: 'lane-review',
      packetId: 'pkt-1',
    });
  });

  it('reports a reset generation race as retryable instead of caching a false hold', async () => {
    h.resetPacket.mockResolvedValue({
      reset: false,
      salvaged: false,
      note: 'Packet state changed before retry salvage could bind.',
    });

    const result = await performAgentControlAction({
      ref: { kind: 'packet', id: 'pkt-1' },
      action: { kind: 'retry' },
    });

    expect(result).toMatchObject({
      ok: false,
      status: 'unavailable',
      packetId: 'pkt-1',
      retryable: true,
      reason: 'packet_state_changed',
    });
  });

  it('returns a terminal packet-steer failure so AgentControl can persist it', async () => {
    h.steerPacket.mockRejectedValueOnce(new SteerPacketUnavailableError(
      'The provider declined the steer after its event was recorded.',
      'terminal',
    ));

    const result = await performAgentControlAction({
      ref: { kind: 'packet', id: 'pkt-1' },
      action: { kind: 'steer', message: 'continue once' },
      clientMutationId: 'packet-steer-terminal',
    });

    expect(result).toMatchObject({
      ok: false,
      status: 'unavailable',
      retryable: false,
      reason: 'steer_unavailable',
      packetId: 'pkt-1',
    });
  });

  it('rethrows a provably pre-effect packet-steer failure for a safe retry', async () => {
    h.steerPacket.mockRejectedValueOnce(new SteerPacketUnavailableError(
      'Packet has no steerable session.',
      'pre_effect',
    ));

    await expect(performAgentControlAction({
      ref: { kind: 'packet', id: 'pkt-1' },
      action: { kind: 'steer', message: 'continue when available' },
      clientMutationId: 'packet-steer-pre-effect',
    })).rejects.toMatchObject({ phase: 'pre_effect' });
  });

  it('preserves the legacy runtime response envelope while using the session seam', async () => {
    h.runtimeAction.mockResolvedValue({
      ok: true,
      action: 'send_input',
      surfaceId: 'codex-owned:s1',
      sessionKey: 'codex-owned:s1',
      runtime: 'codex',
      status: 'queued',
      note: 'Queued.',
    });
    const result = await performLegacyRuntimeActionViaAgentControl({
      action: 'steer',
      surfaceId: 'codex-owned:s1',
      message: 'continue',
      clientMutationId: 'mutation-1',
    });

    expect(h.runtimeAction).toHaveBeenCalledWith(expect.objectContaining({
      action: 'send_input',
      surfaceId: 'codex-owned:s1',
      message: 'continue',
    }));
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      action: 'steer',
      surfaceId: 'codex-owned:s1',
      sessionKey: 'codex-owned:s1',
      runtime: 'codex',
      status: 'queued',
      clientMutationId: 'mutation-1',
    }));
  });
});
