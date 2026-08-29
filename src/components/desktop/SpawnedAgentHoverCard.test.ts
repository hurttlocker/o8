// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { TerminalStatusEvidence } from '@/lib/terminal-status/resolve';
import {
  deriveSpawnedAgentRows,
  type LaneSummary,
} from './AgentPanelExtraAgents';
import { SpawnedAgentHoverCard } from './SpawnedAgentHoverCard';

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;

const anchorRect = {
  x: 20,
  y: 20,
  top: 20,
  right: 220,
  bottom: 52,
  left: 20,
  width: 200,
  height: 32,
  toJSON: () => ({}),
} as DOMRect;

describe('SpawnedAgentHoverCard packet status evidence', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ events: [] }),
    })));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('renders packet evidence when the lane has no fleet agent', async () => {
    const statusEvidence: TerminalStatusEvidence = {
      sessionId: 'codex-owned:packet-only-hover',
      runtime: 'codex',
      state: 'blocked',
      authority: 'lane-state',
      observedAt: '2026-08-29T12:00:00.000Z',
      summary: 'Lane packet-only worker is blocked: worktree_missing_unverified.',
      evidence: [{
        source: 'lane-event:worktree_missing_unverified',
        value: 'awaiting_orchestrator',
      }],
    };
    const packet = {
      id: 'pkt-packet-only-hover',
      statusEvidence,
    } as OrchestratorPacket;
    const lane: LaneSummary = {
      id: 'lane-packet-only-hover',
      label: 'Packet-only worker',
      repoPath: '/repos/packet-only',
      branch: 'issue/packet-only',
      runtime: 'codex',
      sessionKey: statusEvidence.sessionId,
      packetId: packet.id,
      status: 'awaiting_orchestrator',
      ownership: 'managed',
      lastEventAt: statusEvidence.observedAt,
      lastEventLabel: 'worktree_missing_unverified',
    };
    const [row] = deriveSpawnedAgentRows({ lanes: [lane], agents: [], packets: [packet] });

    expect(row?.statusEvidence).toEqual(statusEvidence);
    await act(async () => {
      root.render(createElement(SpawnedAgentHoverCard, {
        row: row!,
        anchorRect,
        onMouseEnter: () => {},
        onMouseLeave: () => {},
      }));
      await Promise.resolve();
    });

    const disclosure = document.body.querySelector(
      `[data-terminal-status-evidence="${statusEvidence.sessionId}"]`,
    );
    expect(disclosure).not.toBeNull();
    expect(disclosure?.textContent).toContain('blocked · lane');
    expect(document.body.textContent).toContain(statusEvidence.summary);
  });
});
