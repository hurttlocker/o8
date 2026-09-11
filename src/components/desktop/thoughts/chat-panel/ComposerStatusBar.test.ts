/** @vitest-environment jsdom */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { summarizeComposerActivity, type ComposerActivityPacket } from '@/lib/orchestrator/composer-activity';
import type { OrchestratorPacketStatus } from '@/lib/orchestrator/types';
import type { MobileTranscriptToolCall } from '@/lib/mobile/types';
import { ComposerStatusBar } from './ComposerStatusBar';

vi.mock('@/components/desktop/AgentStatusDot', () => ({
  AgentStatusDot: () => null,
}));

function packet(status: OrchestratorPacketStatus, overrides: Partial<ComposerActivityPacket> = {}): ComposerActivityPacket {
  return { status, releaseState: 'pending', archivedAt: null, ...overrides };
}

function toolCall(id: string): MobileTranscriptToolCall {
  return { id, name: 'cortex_launch_agent', status: 'running' } as MobileTranscriptToolCall;
}

let container: HTMLDivElement;
let root: Root;

function render(props: Partial<Parameters<typeof ComposerStatusBar>[0]> = {}) {
  act(() => {
    root.render(createElement(ComposerStatusBar, {
      displayWaiting: false,
      runningTools: [],
      workerPackets: [],
      activeTargetLabel: 'Orchestrator',
      latestUserMessageId: null,
      latestUserMessageAt: null,
      awaitingReply: false,
      ...props,
    }));
  });
  return container.querySelector<HTMLElement>('[data-composer-activity]');
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('ComposerStatusBar worker counter (#2148)', () => {
  it('stays on screen and counts the workers after a Multitask dispatch settles the turn', () => {
    // The exact shape of the failure: `cortex_launch_agent` has returned, so
    // the orchestrator's turn is over and it has no running tool calls — while
    // three workers it just launched are running. The bar used to unmount here.
    const bar = render({
      displayWaiting: false,
      runningTools: [],
      awaitingReply: false,
      workerPackets: [packet('running'), packet('running'), packet('launching')],
    });

    expect(bar).not.toBeNull();
    expect(bar?.dataset.workerCount).toBe('3');
    expect(bar?.dataset.orchestratorTools).toBe('0');
    expect(bar?.dataset.orchestratorBusy).toBe('false');
    expect(bar?.textContent).toContain('3 workers');
    expect(bar?.getAttribute('aria-label')).toContain('3 workers running');
  });

  it('names the orchestrator’s own tool calls as tools, not workers', () => {
    const bar = render({
      displayWaiting: true,
      runningTools: [toolCall('t1'), toolCall('t2')],
      workerPackets: [],
    });

    expect(bar?.dataset.workerCount).toBe('0');
    expect(bar?.dataset.orchestratorTools).toBe('2');
    expect(bar?.dataset.orchestratorBusy).toBe('true');
    expect(bar?.textContent).toContain('2 tools');
    expect(bar?.textContent).not.toContain('worker');
  });

  it('keeps the two sides distinguishable while both are in flight', () => {
    const bar = render({
      displayWaiting: true,
      runningTools: [toolCall('t1')],
      workerPackets: [packet('running'), packet('running')],
    });

    expect(bar?.textContent).toContain('1 tool');
    expect(bar?.textContent).toContain('2 workers');
    expect(bar?.dataset.orchestratorTools).toBe('1');
    expect(bar?.dataset.workerCount).toBe('2');
  });

  it('stays hidden when the thread only holds packets that are not running', () => {
    const bar = render({
      workerPackets: [packet('draft'), packet('idle'), packet('awaiting_review'), packet('failed')],
    });

    expect(bar).toBeNull();
  });
});

describe('summarizeComposerActivity', () => {
  it('counts only packets whose dispatch is still in flight', () => {
    const activity = summarizeComposerActivity({
      runningToolCount: 0,
      packets: [
        packet('queued'),
        packet('launching'),
        packet('running'),
        packet('recovering'),
        packet('awaiting_review'),
        packet('blocked'),
        packet('draft'),
        packet('idle'),
        packet('failed'),
        packet('archived'),
      ],
    });

    expect(activity).toEqual({ orchestratorToolCount: 0, workerCount: 4, hasActivity: true });
  });

  it('does not count a released or archived packet that still reads as running', () => {
    const activity = summarizeComposerActivity({
      runningToolCount: 0,
      packets: [
        packet('running', { releaseState: 'released' }),
        packet('running', { archivedAt: '2026-09-11T00:00:00.000Z' }),
      ],
    });

    expect(activity.workerCount).toBe(0);
    expect(activity.hasActivity).toBe(false);
  });
});
