// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import {
  isReusableBlankOrchestratorTab,
  publishWorkspaceThreadBinding,
  WORKSPACE_THREAD_ID_EVENT,
} from './utils';
import type { TerminalTab } from './types';

// Report D3YPBP / Q repro 2026-07-14: "+ New session → Orchestrator" did
// nothing once an orchestrator conversation existed — the spawn's reuse gate
// matched USED tabs because orchestrator transcripts live server-side
// (chatMessages stays empty forever) and the gate never looked at the bound
// thread id. This suite pins the gate's contract with realistic tab shapes.

function orchestratorTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: 'ws-tab-orch-1',
    label: 'Orchestrator',
    kind: 'orchestrator',
    tmuxSession: null,
    freshSpawn: true,
    ...overrides,
  } as TerminalTab;
}

describe('isReusableBlankOrchestratorTab', () => {
  it('reuses a genuinely blank fresh spawn', () => {
    expect(isReusableBlankOrchestratorTab(orchestratorTab())).toBe(true);
  });

  it('NEVER reuses a tab with a bound thread — a live conversation with empty local chatMessages', () => {
    const used = orchestratorTab({ orchestratorThreadId: 'thoughts-abc123', chatMessages: [] });
    expect(isReusableBlankOrchestratorTab(used)).toBe(false);
  });

  it('never reuses a packet-bound tab', () => {
    const packetBound = orchestratorTab({ orchestrationPacket: { id: 'pkt-1' } as never });
    expect(isReusableBlankOrchestratorTab(packetBound)).toBe(false);
  });

  it('never reuses a tab holding a draft injection', () => {
    const drafted = orchestratorTab({ chatDraftInjection: 'fix the login flow' as never });
    expect(isReusableBlankOrchestratorTab(drafted)).toBe(false);
  });

  it('never reuses restored (non-fresh) tabs or other kinds', () => {
    expect(isReusableBlankOrchestratorTab(orchestratorTab({ freshSpawn: undefined }))).toBe(false);
    expect(isReusableBlankOrchestratorTab(orchestratorTab({ kind: 'terminal' as never }))).toBe(false);
  });
});

// D3YPBP ROUND 2 (Chris, Apple Silicon, 2026-07-15): the reuse gate was only
// fed AFTER a thread load landed. When the restore's history fetch failed
// silently (server boot race — worst on slow Rosetta boots), the tab wore the
// old thread's title over an empty transcript while staying INVISIBLE to the
// gate — every "+ New session" click reused the broken tab instead of
// spawning fresh. OrchestratorTab now publishes the binding at restore CLAIM
// time via publishWorkspaceThreadBinding; this pins that bridge contract end
// to end: publish → controller-shaped listener stamps the tab → gate excludes.
describe('publishWorkspaceThreadBinding → reuse-gate exclusion (restore-claim seam)', () => {
  it('emits the workspace-thread event with the exact {tabId, threadId} detail the controller stamps from', () => {
    const seen: Array<{ tabId?: string; threadId?: string | null }> = [];
    const listener = (event: Event) => {
      seen.push((event as CustomEvent<{ tabId?: string; threadId?: string | null }>).detail);
    };
    window.addEventListener(WORKSPACE_THREAD_ID_EVENT, listener);
    try {
      publishWorkspaceThreadBinding('ws-tab-orch-1', 'thoughts-restored-1');
    } finally {
      window.removeEventListener(WORKSPACE_THREAD_ID_EVENT, listener);
    }
    expect(seen).toEqual([{ tabId: 'ws-tab-orch-1', threadId: 'thoughts-restored-1' }]);
  });

  it('a tab stamped from the claim-time event is excluded from blank reuse even with zero messages', () => {
    // Replicates the controller handler's stamping effect on the tab record:
    // the tab has NO messages and NO packet (the half-restored shape), only
    // the claim-time thread id — and must no longer count as blank.
    let tab = orchestratorTab({ chatMessages: [] });
    expect(isReusableBlankOrchestratorTab(tab)).toBe(true); // pre-claim: reusable
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ tabId?: string; threadId?: string }>).detail;
      if (detail?.tabId === tab.id && detail.threadId) {
        tab = { ...tab, orchestratorThreadId: detail.threadId };
      }
    };
    window.addEventListener(WORKSPACE_THREAD_ID_EVENT, listener);
    try {
      publishWorkspaceThreadBinding(tab.id, 'thoughts-restored-2');
    } finally {
      window.removeEventListener(WORKSPACE_THREAD_ID_EVENT, listener);
    }
    expect(tab.orchestratorThreadId).toBe('thoughts-restored-2');
    expect(isReusableBlankOrchestratorTab(tab)).toBe(false); // post-claim: excluded
  });

  it('is a no-op outside a window context (SSR safety)', () => {
    const original = globalThis.window;
    vi.stubGlobal('window', undefined);
    try {
      expect(() => publishWorkspaceThreadBinding('t', 'x')).not.toThrow();
    } finally {
      vi.stubGlobal('window', original);
    }
  });
});
