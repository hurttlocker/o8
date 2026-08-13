import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { focusSwarmPacket, SWARM_CREW_SCROLL_STYLE } from './SwarmStatusCard';

function packet(): OrchestratorPacket {
  return {
    id: 'pkt-123',
    referenceLabel: '#1480',
    title: 'Fix worker focus',
    summary: 'Make running workers reachable',
    workspaceTargetPath: '/repo',
    branchTarget: 'issue/1480',
    runtime: 'codex',
    dependencyLabels: [],
    dependencyPacketIds: [],
    queueState: 'queued',
    releaseState: 'pending',
    status: 'running',
    lane: {
      tileId: 'tile-1',
      tabId: 'tab-1',
      repoPath: '/repo',
      runtime: 'codex',
      sessionKey: 'session-123',
      laneId: 'lane-123',
    },
  };
}

describe('focusSwarmPacket', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('dispatches the spawned-agent focus event with packet lane ids', () => {
    const dispatched: Event[] = [];
    class TestCustomEvent<T = unknown> extends Event {
      detail: T;

      constructor(type: string, init?: CustomEventInit<T>) {
        super(type);
        this.detail = init?.detail as T;
      }
    }
    vi.stubGlobal('CustomEvent', TestCustomEvent);
    vi.stubGlobal('window', {
      dispatchEvent: (event: Event) => {
        dispatched.push(event);
        return true;
      },
    });

    focusSwarmPacket(packet());

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      type: 'o8:focus-spawned-agent-lane',
      detail: {
        packetId: 'pkt-123',
        laneId: 'lane-123',
        sessionKey: 'session-123',
        title: 'Fix worker focus',
      },
    });
  });

  it('calls onFocusPacket when provided', () => {
    const onFocusPacket = vi.fn();
    const targetPacket = packet();

    focusSwarmPacket(targetPacket, onFocusPacket);

    expect(onFocusPacket).toHaveBeenCalledWith(targetPacket);
  });

  it('keeps a large crew scrollable inside the Swarm card on short windows', () => {
    expect(SWARM_CREW_SCROLL_STYLE).toMatchObject({
      maxHeight: 'min(360px, 44vh)',
      overflowY: 'auto',
      overflowX: 'hidden',
      overscrollBehavior: 'contain',
    });
  });
});
