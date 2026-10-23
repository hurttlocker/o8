import { NextRequest } from 'next/server';
import { afterAll, describe, expect, it, vi } from 'vitest';

import type { AgentSummary } from '@/lib/fleet/types';
import type { LaneStatus } from '@/lib/lane/types';

const inventory = vi.hoisted(() => ({ agents: [] as AgentSummary[] }));
vi.mock('@/lib/runtime/inventory', () => ({
  getRuntimeInventorySnapshot: async () => ({ agents: inventory.agents }),
}));

const { GET } = await import('@/app/api/operator/status/route');
const { createLane, getLaneEvents } = await import('@/lib/lane/registry');
const { recordLaneEvent } = await import('@/lib/lane/events');
const { createApproval } = await import('@/lib/approvals/store');
const { closeDb, getSqlite } = await import('@/lib/db');
const observedAt = new Date().toISOString();
const historicalAt = new Date(Date.parse(observedAt) - 60_000).toISOString();

afterAll(() => closeDb());

async function statusFixture(
  previous: 'question' | 'review_ready' | 'spend_cap_hit',
  current: LaneStatus,
  pending?: 'approval' | 'review',
  newerEvent?: LaneStatus,
) {
  const sessionKey = `pi-owned:history-${previous}-${current}-${pending}-${newerEvent}`;
  const lane = createLane({
    repoPath: process.env.CORTEX_IDE_DATA_DIR!,
    branch: 'fixture',
    runtime: 'pi',
    sessionKey,
    label: 'Status history fixture',
  });
  const event = recordLaneEvent(lane.id, previous === 'spend_cap_hit' ? previous : 'agent_report', 'system', {
    event: previous,
    message: 'Historical request',
  });
  getSqlite().prepare('UPDATE lane_events SET timestamp = ? WHERE id = ?').run(historicalAt, event.id);
  getSqlite().prepare('UPDATE lanes SET status = ?, last_event_at = ?, updated_at = ? WHERE id = ?')
    .run(current, observedAt, observedAt, lane.id);
  if (newerEvent) {
    const latest = recordLaneEvent(lane.id, 'status_change', 'system', { status: newerEvent });
    getSqlite().prepare('UPDATE lane_events SET timestamp = ? WHERE id = ?')
      .run(new Date(Date.parse(observedAt) + 1_000).toISOString(), latest.id);
  }
  if (pending === 'approval') {
    const approval = createApproval({
      source: 'test', runtime: 'pi', agent: 'fixture', title: 'Current approval',
      description: 'Current approval', summary: 'Current approval', sessionKey, risk: 'medium',
    });
    getSqlite().prepare('UPDATE approvals SET updated_at = ? WHERE id = ?')
      .run(Date.parse(historicalAt), approval.id);
  }
  if (pending === 'review') {
    getSqlite().prepare(`INSERT INTO review_queue (id, lane_id, repo_path, status, updated_at)
      VALUES (?, ?, ?, 'pending', ?)`)
      .run(`review-${lane.id}`, lane.id, lane.repoPath, historicalAt);
  }
  inventory.agents = [{
    id: sessionKey, sessionKey, runtime: 'pi', name: 'Finished fixture', status: 'completed',
    workspace: process.env.CORTEX_IDE_DATA_DIR!, lastActivityAt: Date.parse(observedAt),
    squadId: '', model: '', currentTask: '', branch: 'fixture', approvalStatus: 'none',
    lastEventAt: observedAt, context: { usedPercent: 0, trend: 'stable' }, alerts: 0,
  }];

  // Reopen SQLite so the route consumes persisted records, not fixture objects.
  closeDb();
  const response = await GET(new NextRequest(`http://localhost/api/operator/status?sessionKey=${sessionKey}`));
  expect(response.status).toBe(200);
  const payload = await response.json();
  expect(payload.agents).toHaveLength(1);
  expect(getLaneEvents(lane.id)).toContainEqual(expect.objectContaining({ id: event.id, timestamp: historicalAt }));
  return payload;
}

describe('terminal status history through the operator route', () => {
  it.each(['question', 'review_ready', 'spend_cap_hit'] as const)(
    'does not revive a superseded %s after the lane completes',
    async (previous) => {
      const payload = await statusFixture(previous, 'completed');
      expect(payload.agents[0]).toMatchObject({
        status: 'completed', authority: 'runtime-event', statusEvidence: { state: 'complete' },
      });
      expect(payload.agents[0].statusEvidence.evidence).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: `lane-event:${previous}` }),
      ]));
      expect(payload.summary).not.toContain('needs attention');
      expect(payload.summary).not.toContain('awaiting review');
    },
  );

  it('does not revive a question after the lane returns to running and its turn finishes', async () => {
    const payload = await statusFixture('question', 'running');
    expect(payload.agents[0]).toMatchObject({ status: 'completed', authority: 'runtime-event' });
  });

  it.each([
    ['awaiting_input', 'blocked'],
    ['reviewing', 'awaiting_review'],
  ] as const)('keeps a current %s lane authoritative over a finished turn', async (current, expected) => {
    const payload = await statusFixture('question', current);
    expect(payload.agents[0]).toMatchObject({ status: expected, authority: 'lane-state' });
  });

  it('keeps an unresolved approval authoritative even when it predates the latest lane observation', async () => {
    const payload = await statusFixture('question', 'completed', 'approval');
    expect(payload.agents[0]).toMatchObject({ status: 'blocked', authority: 'lane-state' });
    expect(payload.approvals.count).toBe(1);
  });

  it('keeps an unresolved review authoritative even when it predates the latest lane observation', async () => {
    const payload = await statusFixture('question', 'completed', 'review');
    expect(payload.agents[0]).toMatchObject({ status: 'awaiting_review', authority: 'lane-state' });
  });

  it('uses a newer lifecycle event to supersede an older blocked lane observation', async () => {
    const payload = await statusFixture('question', 'awaiting_input', undefined, 'completed');
    expect(payload.agents[0]).toMatchObject({ status: 'completed', authority: 'runtime-event' });
  });

  it('keeps a newer blocking event authoritative over an older completed lane observation', async () => {
    const payload = await statusFixture('question', 'completed', undefined, 'awaiting_input');
    expect(payload.agents[0]).toMatchObject({ status: 'blocked', authority: 'lane-state' });
  });
});
