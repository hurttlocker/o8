/**
 * #1553 + #1475 — tab identity truth.
 *
 * Field incidents:
 *  - #1553: a lane relaunch loop minted a fresh `codex-owned:` sessionKey per
 *    attempt; with no packetId to rebind on, every attempt stacked a NEW chat
 *    tab (Polish ×5 / Huddle ×5 zombies persisted in repo-1iwg8hk.json).
 *  - #1475: setTabLabelIfAuto matched by chatSessionKey — which supervisor
 *    retries REBIND — so one packet's freshly-derived label landed on a tab
 *    that belongs to a different session ("hey buddy" cross-wire). And the
 *    mission-carded dedupe Set was in-memory only, so a mission completed
 *    within the detector's 5-minute stale window re-carded on every boot.
 *
 * All three fixes are exercised through their REAL entry points:
 * computeCliChatSession, buildTerminalTabHandle().setTabLabelIfAuto, and the
 * markMissionCarded/hasMissionBeenCarded pair across a simulated module reload.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { computeCliChatSession } from '@/components/desktop/workspace-terminal/terminal-session-ops';
import { buildTerminalTabHandle, type ImperativeHandleDeps } from '@/components/desktop/workspace-terminal/terminal-imperative-handle';
import { buildPersistedState } from '@/components/desktop/workspace-terminal/terminal-tab-handlers';
import type { RegisteredRepo, TerminalTab } from '@/components/desktop/workspace-terminal/types';

const repo: RegisteredRepo = { name: 'o8', localPath: '/tmp/o8', branch: 'main' };

function laneTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  const now = Date.now();
  return {
    id: 'chat-attempt-1',
    label: 'Polish',
    kind: 'chat',
    tmuxSession: null,
    chatRuntime: 'codex',
    chatSessionKey: 'codex-owned:attempt-1',
    laneId: 'lane-polish',
    repo,
    orchestrationPacket: null,
    createdAt: now,
    lastActivity: now,
    chatMessages: [],
    ...overrides,
  };
}

describe('#1553 — packet-less lane relaunch retargets the existing tab', () => {
  it('reuses the lane tab when a relaunch arrives with a FRESH sessionKey', () => {
    const existing = laneTab();
    const result = computeCliChatSession(
      {
        runtime: 'codex',
        repo,
        targetSessionKey: 'codex-owned:attempt-2',
        laneId: 'lane-polish',
        label: 'Polish',
        createNew: false,
        orchestrationPacket: null,
      },
      [existing],
      existing.id,
    );

    // Old code minted a second tab per attempt — the ×5 zombie stack.
    expect(result.tabs).toHaveLength(1);
    expect(result.tabs[0]?.id).toBe(existing.id);
    expect(result.tabs[0]?.chatSessionKey).toBe('codex-owned:attempt-2');
    expect(result.tabs[0]?.laneId).toBe('lane-polish');
  });

  it('still mints a new tab for a DIFFERENT lane', () => {
    const existing = laneTab();
    const result = computeCliChatSession(
      {
        runtime: 'codex',
        repo,
        targetSessionKey: 'codex-owned:huddle-1',
        laneId: 'lane-huddle',
        label: 'Huddle',
        createNew: false,
        orchestrationPacket: null,
      },
      [existing],
      existing.id,
    );

    expect(result.tabs).toHaveLength(2);
    expect(result.tabs[1]?.laneId).toBe('lane-huddle');
  });

  it('persists laneId so the retarget survives a reload', () => {
    const persisted = buildPersistedState([laneTab()], 'chat-attempt-1');
    expect(persisted.tabs[0]?.laneId).toBe('lane-polish');
  });
});

describe('#1475 — setTabLabelIfAuto never cross-wires labels between packets', () => {
  function makeHandle(tabs: TerminalTab[]) {
    const setTabs = vi.fn();
    const deps = {
      tabsRef: { current: tabs },
      panelRefs: { current: new Map() },
      detectedPortsRef: { current: new Set() },
      urlDetectionEnabledRef: { current: false },
      restoreSettledRef: { current: true },
      pendingRequestRef: { current: new Map() },
      activeTabId: tabs[0]?.id ?? '',
      stateScope: 'test',
      preferredRepo: null,
      setTabs,
      setPreviews: vi.fn(),
      setActiveTabId: vi.fn(),
      handleSessionCreated: vi.fn(),
      openWorkspaceCliChatSession: vi.fn(),
      openWorkspaceLlmChatSession: vi.fn(),
      openWorkspaceOrchestratorTab: vi.fn(),
      openWorkspaceTerminalTab: vi.fn(),
      openWorkspaceInspectorTab: vi.fn(),
      persistTabsNow: vi.fn(),
      sendTerminalDetach: vi.fn(),
      closeTabById: vi.fn(),
      recordTerminalActivity: vi.fn(),
    } as unknown as ImperativeHandleDeps;
    return { handle: buildTerminalTabHandle(deps), setTabs };
  }

  it('refuses a sessionKey hit on a tab bound to a DIFFERENT packet', () => {
    const tab = laneTab({
      id: 'tab-p1',
      chatSessionKey: 'codex-owned:shared-key',
      orchestrationPacket: {
        packetId: 'packet-1',
        referenceLabel: 'PKT-1',
        title: 'Original',
        status: 'running',
        runtime: 'codex',
        branchTarget: null,
      },
    });
    const { handle, setTabs } = makeHandle([tab]);

    // Old code: keys=[sessionKey, packetId] matched tab-p1 via chatSessionKey
    // and wrote packet-2's label onto packet-1's tab.
    const updated = handle.setTabLabelIfAuto(
      { sessionKey: 'codex-owned:shared-key', packetId: 'packet-2' },
      'Packet Two Title',
    );

    expect(updated).toBe(false);
    expect(setTabs).not.toHaveBeenCalled();
  });

  it('prefers the immutable packetId over a rebound sessionKey', () => {
    const boundTab = laneTab({
      id: 'tab-p1',
      chatSessionKey: 'codex-owned:rebound-new',
      label: 'stale label',
      orchestrationPacket: {
        packetId: 'packet-1',
        referenceLabel: 'PKT-1',
        title: 'Original',
        status: 'running',
        runtime: 'codex',
        branchTarget: null,
      },
    });
    const bystander = laneTab({ id: 'tab-other', chatSessionKey: 'codex-owned:old-key', laneId: 'lane-other' });
    const { handle, setTabs } = makeHandle([bystander, boundTab]);

    const updated = handle.setTabLabelIfAuto(
      { sessionKey: 'codex-owned:old-key', packetId: 'packet-1' },
      'Fresh Canonical Title',
    );

    expect(updated).toBe(true);
    expect(setTabs).toHaveBeenCalledTimes(1);
    const updater = setTabs.mock.calls[0][0] as (tabs: TerminalTab[]) => TerminalTab[];
    const next = updater([bystander, boundTab]);
    expect(next.find((t) => t.id === 'tab-p1')?.label).toBe('Fresh Canonical Title');
    expect(next.find((t) => t.id === 'tab-other')?.label).toBe('Polish');
  });
});

describe('#1475 — mission-carded dedupe survives a boot', () => {
  const storage = new Map<string, string>();

  beforeEach(() => {
    storage.clear();
    vi.resetModules();
    // store.ts's import chain installs a fetch patch on window at module load
    // (turn-pins.ts) — the stub needs a bindable fetch for the reload to work.
    vi.stubGlobal('window', {
      fetch: vi.fn(async () => new Response('{}')),
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => { storage.set(key, value); },
        removeItem: (key: string) => { storage.delete(key); },
      },
    });
    return () => vi.unstubAllGlobals();
  });

  it('a mission carded before the boot is still carded after it', async () => {
    const before = await import('@/lib/orchestrator/store');
    before.markMissionCarded('mission-boot-window');
    expect(before.hasMissionBeenCarded('mission-boot-window')).toBe(true);

    // Simulate the boot: module state is torn down, localStorage survives.
    vi.resetModules();
    const after = await import('@/lib/orchestrator/store');

    // Old code: in-memory Set only — this returned false and the <5min-old
    // completed mission re-carded into the fresh transcript.
    expect(after.hasMissionBeenCarded('mission-boot-window')).toBe(true);
  });

  it('caps the persisted set and keeps the newest ids', async () => {
    const store = await import('@/lib/orchestrator/store');
    for (let i = 0; i < 120; i += 1) store.markMissionCarded(`mission-${i}`);
    expect(store.hasMissionBeenCarded('mission-119')).toBe(true);
    expect(store.hasMissionBeenCarded('mission-0')).toBe(false);
    const persisted = JSON.parse(storage.get('o8:carded-mission-ids:v1') ?? '[]') as string[];
    expect(persisted.length).toBeLessThanOrEqual(100);
    expect(persisted).toContain('mission-119');
  });
});
