/**
 * Mobile approve/merge ADDRESSING — driven through the REAL route handler.
 *
 * WHY THIS EXISTS — the reachability rule (CLAUDE.md "Real-path tests"). The
 * hazard being closed is a mis-targeted merge: the mobile `approve` action used
 * to fall back to a `sessionKey`→pending lookup, so a STALE/recycled sessionKey
 * (session renamed, or reused for new work) could resolve to the WRONG pending
 * approval and merge it. Testing the `selectMobileReviewApprovalId` helper in
 * isolation proves the selector, not the route — exactly the "green tests encode
 * the premise" trap. So this suite constructs real Requests, drives the actual
 * POST handler against persisted approvals, and asserts the observable effect on
 * the store (which card flipped, which stayed pending).
 *
 * Contract asserted:
 *   (a) explicit approvalId + STALE sessionKey → the ADDRESSED card resolves,
 *       the stale-key card is untouched (no session fallback, no mis-target).
 *   (b) no approvalId + one pending → legacy session lookup still works.
 *   (c) no approvalId + two pending → ambiguous_approval (409) with both ids,
 *       nothing mutated.
 *   (d) explicit approvalId already resolved → approval_resolved (410), no
 *       fallback to the session's other pending card, nothing mutated.
 */
import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { CreateApprovalInput } from '@/lib/approvals/types';

// The handler publishes over WS on the success path — stub it so the route runs
// its ADDRESSING logic without touching the network.
vi.mock('@/lib/realtime/publisher', () => ({
  publishRealtimeMutation: vi.fn(async () => {}),
}));

// Dynamic imports — resolve after the hermetic data dir + mock are in place.
const action = await import('@/app/api/mobile/action/route');
const { createApproval, getApproval, resolveApproval } = await import('@/lib/approvals/store');

function post(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3001/api/mobile/action', {
    method: 'POST',
    headers: { host: 'localhost:3001', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * A distinct pending approval under `sessionKey`. `tag` varies the summary+args
 * so two cards under the SAME sessionKey get different fingerprints (the store
 * dedupes identical fingerprints, which would otherwise collapse them into one).
 */
function pendingApproval(sessionKey: string, tag: string) {
  const input: CreateApprovalInput = {
    source: 'test',
    runtime: 'codex',
    agent: 'Test Harness',
    sessionKey,
    title: `Merge ${tag}`,
    description: `Approve and merge worktree ${tag}.`,
    summary: `merge-${tag}`,
    toolName: 'lane_merge',
    args: { tag },
    command: `merge ${tag}`,
    editable: true,
    risk: 'medium',
    metadata: { Session: sessionKey, Tag: tag },
  };
  return createApproval(input);
}

describe('mobile /action approve — approvalId is authoritative (stale sessionKey cannot mis-target a merge)', () => {
  it('(a) explicit approvalId + STALE sessionKey resolves the ADDRESSED card and leaves the stale-key card pending', async () => {
    const target = pendingApproval('codex-owned:real-session', 'target');
    // What the stale sessionKey resolves to — a session fallback would grab THIS.
    const decoy = pendingApproval('codex-owned:stale-session', 'decoy');

    const res = await action.POST(post({
      action: 'approve',
      sessionKey: 'codex-owned:stale-session', // STALE / mismatched — must be ignored for addressing
      approvalId: target.id,                    // authoritative
    }));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    // The response echoes the ADDRESSED card's real session, not the stale request key.
    expect(json.sessionKey).toBe('codex-owned:real-session');

    // The addressed card flipped; the stale-key card was NOT mis-targeted.
    expect(getApproval(target.id)?.status).toBe('approved');
    expect(getApproval(decoy.id)?.status).toBe('pending');
  });

  it('(b) no approvalId + exactly one pending resolves it (legacy session lookup, back-compat)', async () => {
    const only = pendingApproval('codex-owned:legacy-single', 'only');

    const res = await action.POST(post({ action: 'approve', sessionKey: 'codex-owned:legacy-single' }));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(getApproval(only.id)?.status).toBe('approved');
  });

  it('(c) no approvalId + two pending refuses with ambiguous_approval (409) + both ids, nothing mutated', async () => {
    const a = pendingApproval('codex-owned:legacy-ambig', 'a');
    const b = pendingApproval('codex-owned:legacy-ambig', 'b');

    const res = await action.POST(post({ action: 'approve', sessionKey: 'codex-owned:legacy-ambig' }));

    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error).toBe('ambiguous_approval');
    expect(new Set(json.approvalIds)).toEqual(new Set([a.id, b.id]));

    // Refused, not guessed — both cards stay pending.
    expect(getApproval(a.id)?.status).toBe('pending');
    expect(getApproval(b.id)?.status).toBe('pending');
  });

  it('(d) explicit approvalId already resolved → approval_resolved (410), no fallback, nothing mutated', async () => {
    const done = pendingApproval('codex-owned:resolved-session', 'done');
    resolveApproval(done.id, 'approve', 'desktop', 'resolved out of band');
    const before = getApproval(done.id);
    expect(before?.status).toBe('approved');

    // A DIFFERENT pending card under the SAME sessionKey — a fallback would grab it.
    const fallback = pendingApproval('codex-owned:resolved-session', 'fallback');

    const res = await action.POST(post({
      action: 'approve',
      sessionKey: 'codex-owned:resolved-session',
      approvalId: done.id,
    }));

    expect(res.status).toBe(410);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error).toBe('approval_resolved');

    // No fallback: the session's other pending card is untouched.
    expect(getApproval(fallback.id)?.status).toBe('pending');
    // No re-mutation of the already-resolved card.
    expect(getApproval(done.id)?.updatedAt).toBe(before?.updatedAt);
  });

  it('(e) explicit approvalId that does not exist → approval_not_found (409), no session fallback', async () => {
    // A pending card exists for the session; a fallback would grab it.
    const fallback = pendingApproval('codex-owned:missing-id-session', 'fallback');

    const res = await action.POST(post({
      action: 'approve',
      sessionKey: 'codex-owned:missing-id-session',
      approvalId: 'approval-does-not-exist',
    }));

    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error).toBe('approval_not_found');
    expect(getApproval(fallback.id)?.status).toBe('pending');
  });
});
