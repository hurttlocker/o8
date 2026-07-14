import { describe, it, expect } from 'vitest';
import { isReusableBlankOrchestratorTab } from './utils';
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
