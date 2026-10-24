// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getPendingMissionCards, useMissionCompleteDetector } from './mission-complete-detector';
import type { OrchestratorMissionState } from '@/lib/orchestrator/types';
import { useOrchestratorStatusFeed } from './useOrchestratorStatusFeed';
import { OrchestratorStatusCard } from './chat-panel/OrchestratorStatusCard';
import { MissionCompleteGroupCard } from './chat-panel/MissionCompleteGroupCard';
import { SpawnedAgentHoverCard } from '../SpawnedAgentHoverCard';
import { ExtraAgentRowView, type ExtraAgentRow } from '../AgentPanelExtraAgentRow';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it.each(['no_changes', 'merged', 'closed_unmerged', null])('renders the live terminal event truthfully with outcome %s before packets refresh', async (outcome) => {
  const entries: MobileTranscriptEntry[] = [];
  function Feed() {
    useOrchestratorStatusFeed({ active: true, repoPath: '/repo', threadId: 'thread', missionPackets: [],
      appendLocalEntries: (added) => entries.push(...added) });
    return null;
  }
  await act(async () => root.render(createElement(Feed)));
  await act(async () => window.dispatchEvent(new CustomEvent('o8:lane-lifecycle', { detail: { data: {
    laneId: 'lane', packetId: 'packet', status: outcome === 'closed_unmerged' ? 'archived' : 'completed',
    previousStatus: 'running', label: 'Inspect packet state', outcome, repoPath: '/repo', branch: 'task',
  } } })));
  expect(entries).toHaveLength(1);
  await act(async () => root.render(createElement(OrchestratorStatusCard, { event: entries[0].statusEvent! })));
  expect(host.textContent).toContain('Inspect packet state');
  expect(host.textContent).toContain(outcome === 'merged' ? 'Merged' : outcome === 'closed_unmerged' ? 'Closed' : 'Completed');
  if (outcome !== 'merged') expect(host.textContent).not.toContain('Merged');
});

it('does not turn a zero-merge mission into a merged aggregate', async () => {
  await act(async () => root.render(createElement(MissionCompleteGroupCard, { entries: [
    { key: 'one', event: { kind: 'mission-complete', mergedCount: 0 } },
    { key: 'two', event: { kind: 'mission-complete', mergedCount: 0 } },
  ] })));
  expect(host.textContent).toContain('2 missions completed');
  expect(host.textContent).not.toContain('merged');
});

it.each([
  ['completed', 'no_changes', false], ['archived', 'closed_unmerged', false],
  ['completed', 'merged', false], ['failed', null, true], ['failed', 'no_changes', false], ['failed', 'archived_recoverable', true], ['recovering', 'pr_opened', true], ['failed', 'asked', true],
] as const)('shows Retry only for an unresolved failure (%s, %s)', async (laneStatus, outcome, retry) => {
  const row: ExtraAgentRow = { key: 'lane', name: 'Inspect packet state', origin: 'CLI', status: 'idle', runtime: 'codex',
    model: null, subtitle: '', lastActivityAt: 0, sessionKey: null, repoPath: '/repo', packetId: 'packet', laneId: 'lane',
    laneStatus, outcome, outcomeNote: null, lastEventLabel: null };
  await act(async () => root.render(createElement(ExtraAgentRowView, { row, active: false, busy: false, band: 'finished', onRetryPacket: vi.fn() })));
  expect(Boolean(host.querySelector('[title="Retry failed packet"]'))).toBe(retry);
});

it.each([0, 1])('counts only proven merges in a mixed terminal mission (%s merges)', async (mergedCount) => {
  const state = { missionId: `completion-mission-${mergedCount}`, repoPath: '/repo', summary: 'Inspect packets', packets: [0, 1].map((n) => ({
    id: `packet-${n}`, title: `Packet ${n}`, referenceLabel: `P${n}`, orchestratorThreadId: 'thread',
    releaseState: 'released', releaseStatePayload: { releasedAt: new Date().toISOString(),
      source: n < mergedCount ? 'approve_and_merge' : 'read_only_completed',
      mergeCommit: n < mergedCount ? 'a'.repeat(40) : null,
      evidenceKind: n < mergedCount ? 'ancestor' : 'read_only_no_merge_required' },
  })) } as OrchestratorMissionState;
  function Detector() { useMissionCompleteDetector(state); return null; }
  await act(async () => root.render(createElement(Detector)));
  const entries = getPendingMissionCards('/repo', 'thread');
  expect(entries).toHaveLength(1);
  expect(entries[0].statusEvent).toMatchObject({ kind: 'mission-complete', mergedCount });
});

it('keeps the no-change outcome in the actual completed-lane hover card', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ events: [] })));
  const row: ExtraAgentRow = { key: 'hover-lane', name: 'Inspect packet state', origin: 'CLI', status: 'idle', runtime: 'codex',
    model: null, subtitle: '', lastActivityAt: 0, sessionKey: null, repoPath: '/repo', packetId: 'packet', laneId: 'lane',
    laneStatus: 'completed', outcome: 'no_changes', outcomeNote: null, lastEventLabel: null };
  await act(async () => root.render(createElement(SpawnedAgentHoverCard, { row, anchorRect: new DOMRect(0, 0, 100, 20),
    onMouseEnter: vi.fn(), onMouseLeave: vi.fn() })));
  expect(document.body.textContent).toContain('Finished — no changes');
  expect(document.body.textContent).not.toContain('Merged');
});
