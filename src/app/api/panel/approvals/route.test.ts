/**
 * Real-path test for the approvals list payload — driven through the actual GET handler
 * with constructed NextRequests against persisted rows.
 *
 * Measured on a real machine 2026-07-29: `?status=all` returned 7.9MB across 468 rows,
 * 5.6MB of which was stored `diff` previews (~12KB/row) that nothing in a list view reads,
 * and four separate components poll that endpoint during one dashboard boot. Over the
 * machine relay that alone was ~47MB per boot.
 */
import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

const { createApproval } = await import('@/lib/approvals/store');
const approvalsRoute = await import('./route');

function seedApproval(overrides: { sessionKey: string; laneId?: string }) {
  return createApproval({
    source: 'orchestrator',
    runtime: 'codex',
    agent: 'codex',
    sessionKey: overrides.sessionKey,
    title: 'Merge packet',
    description: 'Merge the packet worktree into main',
    summary: 'one file changed',
    risk: 'medium',
    diff: { files: [{ path: 'src/thing.ts', additions: 2, deletions: 1 }], raw: 'x'.repeat(4096) },
    // Context matching reads lane/packet ids out of metadata (see
    // scoreApprovalContextMatch), which is what a detail lookup queries by.
    ...(overrides.laneId ? { metadata: { Lane: overrides.laneId } } : {}),
  } as unknown as Parameters<typeof createApproval>[0]);
}

async function listVia(query: string) {
  const response = await approvalsRoute.GET(
    new NextRequest(`http://127.0.0.1/api/panel/approvals${query}`),
  );
  expect(response.status).toBe(200);
  const payload = await response.json() as { approvals: { diff?: unknown; summary?: string }[] };
  return payload.approvals;
}

describe('GET /api/panel/approvals — list payload weight', () => {
  it('omits stored diff previews from a broad list while keeping the rest of the row', async () => {
    seedApproval({ sessionKey: 'codex:list-weight-1' });

    const approvals = await listVia('?status=all');

    expect(approvals.length).toBeGreaterThan(0);
    // Pre-fix every row carried its full diff — megabytes no list view reads.
    for (const approval of approvals) {
      expect(approval.diff).toBeUndefined();
    }
    expect(approvals.some((approval) => approval.summary === 'one file changed')).toBe(true);
  });

  it('still returns the diff when a caller asks for it', async () => {
    seedApproval({ sessionKey: 'codex:list-weight-2' });

    const approvals = await listVia('?status=all&include=diff');

    expect(approvals.some((approval) => approval.diff !== undefined)).toBe(true);
  });

  it('keeps the diff on a context query, which is the detail lookup', async () => {
    const laneId = 'lane-list-weight-3';
    seedApproval({ sessionKey: 'codex:list-weight-3', laneId });

    const approvals = await listVia(`?status=all&laneId=${laneId}`);

    expect(approvals.length).toBeGreaterThan(0);
    expect(approvals.every((approval) => approval.diff !== undefined)).toBe(true);
  });
});
