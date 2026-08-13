import { describe, expect, it } from 'vitest';

import { composeSupervisorInboxCardCopy } from '@/lib/inbox/card-copy';
import type { SupervisorInboxItem } from '@/lib/supervisor/inbox';

function item(overrides: Partial<SupervisorInboxItem> = {}): SupervisorInboxItem {
  return {
    id: 'inbox-1',
    projectId: 'default',
    repoPath: '/Users/op/o8',
    packetId: 'pkt-abc',
    kind: 'silent_exit_verification_failed',
    incidentKey: null,
    payload: { verificationKind: 'typecheck' } as SupervisorInboxItem['payload'],
    createdAt: '2026-07-06T00:00:00.000Z',
    lastSeenAt: '2026-07-06T00:00:00.000Z',
    repeatCount: 1,
    status: 'pending',
    resolvedAt: null,
    resolutionLaneId: null,
    packetTitle: 'Incident cards in plain English (UI-truth U4) #1471',
    packetReferenceLabel: 'inline-1',
    sessionKey: null,
    worktreePath: '/Users/op/o8/.cortex-worktrees/packet-pkt-abc',
    transcriptLink: null,
    worktreeLink: null,
    errorExcerpt: 'Command failed: npx tsc --noEmit',
    problemDossierId: null,
    ...overrides,
  };
}

describe('composeSupervisorInboxCardCopy', () => {
  it('turns silent_exit_verification_failed into a plain-English headline with files as metadata', () => {
    const copy = composeSupervisorInboxCardCopy(item());
    // Headline: a full sentence, no internal status codes.
    expect(copy.headline).toMatch(/could not verify/i);
    expect(copy.headline).not.toMatch(/silent_exit|verification_failed/);
    // Subline keeps the concrete pointers: packet, repo, worktree, issue refs.
    expect(copy.subline).toContain('inline-1');
    expect(copy.subline).toContain('.cortex-worktrees/packet-pkt-abc');
    expect(copy.subline).toContain('#1471');
    // The actual failure text must survive — dropping it was a real regression (review catch).
    expect(copy.subline).toContain('Command failed: npx tsc --noEmit');
  });

  it('covers packet_missing with an actionable sentence', () => {
    const copy = composeSupervisorInboxCardCopy(item({ kind: 'packet_missing' }));
    expect(copy.headline.length).toBeGreaterThan(20);
    expect(copy.headline).not.toMatch(/packet_missing/);
  });

  it('never loses information on unknown kinds — falls back to packet label + excerpt', () => {
    const copy = composeSupervisorInboxCardCopy(
      item({ kind: 'never_seen_before' as SupervisorInboxItem['kind'] }),
    );
    expect(copy.headline).toContain('Incident cards in plain English');
    expect(copy.subline).toContain('Command failed: npx tsc --noEmit');
  });

  it('survives null-heavy items without throwing', () => {
    const copy = composeSupervisorInboxCardCopy(item({
      packetTitle: null,
      packetReferenceLabel: null,
      worktreePath: null,
      payload: {} as SupervisorInboxItem['payload'],
    }));
    expect(copy.headline.length).toBeGreaterThan(0);
    expect(copy.subline.length).toBeGreaterThan(0);
  });
});
