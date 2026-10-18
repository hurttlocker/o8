// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { SwarmStatusCard, focusSwarmPacket, packetsForOrchestratorThread, SWARM_CREW_SCROLL_STYLE } from './SwarmStatusCard';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

  it('keeps the Swarm crew scoped to its originating orchestrator chat', () => {
    const direct = { ...packet(), id: 'pkt-direct', orchestratorThreadId: 'thoughts-current' };
    const attributed = {
      ...packet(),
      id: 'pkt-attributed',
      dispatcher: { surface: 'orchestrator' as const, id: 'thoughts-current' },
    };
    const stale = { ...packet(), id: 'pkt-stale', orchestratorThreadId: 'thoughts-previous' };

    expect(packetsForOrchestratorThread([direct, attributed, stale], 'thoughts-current'))
      .toEqual([direct, attributed]);
    expect(packetsForOrchestratorThread([direct], null)).toEqual([]);
  });
});

describe('subagent disclosure', () => {
  it('shows native failure and missing receipts without offering unsupported worker controls', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(SwarmStatusCard, {
        packets: [], defaultExpanded: true,
        scouts: [{ id: 'native-failed', label: 'Inspect auth', status: 'failed' }, { id: 'native-unknown', label: 'Inspect routes', status: 'unknown' }],
      })));
      expect(host.textContent).toContain('1 failed · 1 unconfirmed');
      expect(host.textContent).toContain('Inspect auth');
      expect(host.textContent).toContain('Managed by this conversation');
      expect(host.querySelector('[data-swarm-crew]')?.querySelector('button')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it('starts compact, counts durable identities once, and opens the current worker binding', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const focus = vi.fn();
    const running = packet();
    const review = { ...packet(), id: 'pkt-review', title: 'Review changes', status: 'awaiting_review' as const };
    try {
      await act(async () => root.render(createElement(SwarmStatusCard, { packets: [running, running, review], onFocusPacket: focus })));
      const toggle = host.querySelector<HTMLButtonElement>('[aria-expanded]')!;
      expect(toggle?.getAttribute('aria-expanded')).toBe('false');
      expect(toggle?.textContent).toContain('2 subagents');
      expect(toggle?.textContent).toContain('1 running');
      expect(toggle?.textContent).toContain('1 awaiting review');
      expect(host.textContent).not.toContain('Fix worker focus');
      await act(async () => toggle.click());
      expect(toggle.getAttribute('aria-controls')).toBe(host.querySelector('[data-swarm-crew]')?.id);
      const rebound = { ...running, lane: { ...running.lane!, sessionKey: 'session-new' } };
      await act(async () => root.render(createElement(SwarmStatusCard, { packets: [rebound, review], onFocusPacket: focus })));
      await act(async () => host.querySelector<HTMLButtonElement>('[title="Open Fix worker focus"]')!.click());
      expect(focus).toHaveBeenCalledWith(rebound);
      expect(host.querySelector('[aria-expanded]')?.getAttribute('aria-expanded')).toBe('true');
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});


it('uses sidebar status marks and requires a merge receipt before showing merged', async () => {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(SwarmStatusCard, { defaultExpanded: true, packets: [
      packet(), { ...packet(), id: 'failed', title: 'Failure', status: 'failed' },
      { ...packet(), id: 'review', title: 'Review', status: 'awaiting_review' },
      { ...packet(), id: 'complete', title: 'Complete', status: 'released', releaseState: 'released' },
      { ...packet(), id: 'merged', title: 'Merge', status: 'released', releaseState: 'released', releaseStatePayload: { mergeCommit: 'abc123' } },
    ] })));
    const mark = (title: string) => host.querySelector(`[title="Open ${title}"] .o8-fam`)!;
    expect(mark('Fix worker focus').classList.contains('fam-working')).toBe(true);
    expect((mark('Fix worker focus') as HTMLElement).style.getPropertyValue('--fam-c')).toBe('var(--t-accent)');
    expect(mark('Failure').classList.contains('fam-stopped')).toBe(true);
    expect(mark('Review').classList.contains('fam-review')).toBe(true);
    expect(mark('Complete').classList.contains('fam-merged')).toBe(false);
    expect(mark('Merge').classList.contains('fam-merged')).toBe(true);
    expect(host.textContent).toContain('1 completed');
    expect(host.textContent).toContain('1 merged');
  } finally { await act(async () => root.unmount()); host.remove(); }
});
