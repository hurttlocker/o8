import { describe, expect, it } from 'vitest';
import type { SupervisorInboxItem } from '@/lib/supervisor/inbox';
import type { MaintainerContribution } from './maintainer-types';
import { maintainerReplyQueue } from './maintainer-replies';

const earlier = '2026-10-01T12:00:00Z';
const later = '2026-10-02T12:00:00Z';
const snapshot = (number = 1, waitingSince = earlier): MaintainerContribution => ({ id: `reply:${number}`, kind: 'reply', repo: 'example/repo', repoPaths: ['/workspace'], number, title: 'Question', author: 'contributor', assignees: [], url: `https://github.com/example/repo/issues/${number}`, createdAt: earlier, updatedAt: waitingSince, waitingSince, threadKind: 'issue' });
const incident = (status: SupervisorInboxItem['status'] = 'pending', waitingSince = earlier): SupervisorInboxItem => ({ id: 'incident', projectId: 'project', repoPath: '/workspace', packetId: null, kind: 'outside_human_waiting', incidentKey: null, payload: { threadRepo: 'EXAMPLE/repo', threadKind: 'issue', threadNumber: 1, waitingSince }, createdAt: earlier, lastSeenAt: earlier, repeatCount: 1, status, resolvedAt: null, resolutionLaneId: null, packetTitle: null, packetReferenceLabel: null, sessionKey: null, worktreePath: null, transcriptLink: null, worktreeLink: null, errorExcerpt: '', problemDossierId: null });

describe('maintainer reply queue', () => {
  it('shows one existing incident and preserves a dismissal for the same message', () => {
    expect(maintainerReplyQueue([incident()], [snapshot()]).map((item) => item.id)).toEqual(['incident']);
    expect(maintainerReplyQueue([incident('dismissed')], [snapshot()])).toEqual([]);
    expect(maintainerReplyQueue([incident('resolved')], [snapshot()])).toEqual([]);
  });
  it('resurfaces a newer reply without resurrecting its older incident', () => {
    for (const status of ['pending', 'dismissed', 'resolved'] as const) {
      expect(maintainerReplyQueue([incident(status)], [snapshot(1, later)]).map((item) => item.id)).toEqual(['reply:1']);
    }
  });
  it('orders fresh replies and pending incidents by how long the person has waited', () => {
    expect(maintainerReplyQueue([incident()], [snapshot(2, later)]).map((item) => item.id)).toEqual(['incident', 'reply:2']);
  });
});
