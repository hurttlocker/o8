export type WorkerActivitySource = 'transcript_progress' | 'worktree_write';

export async function invalidateReviewingLaneForWorkerActivity(input: {
  surfaceId: string;
  source: WorkerActivitySource;
  lastMessage?: string;
}): Promise<boolean> {
  const { appendEvent, findLaneBySession, updateLane } = await import('@/lib/lane/registry');
  const lane = findLaneBySession(input.surfaceId);
  if (!lane || lane.runtime !== 'codex' || lane.status !== 'reviewing') {
    return false;
  }

  const event = appendEvent(lane.id, 'review_invalidated', 'system', {
    reason: 'worker_activity_after_review',
    source: input.source,
    surfaceId: input.surfaceId,
    packetId: lane.packetId,
    worktreePath: lane.worktreePath,
    lastMessageLength: input.lastMessage?.length ?? 0,
  });

  const updated = updateLane(lane.id, {
    status: 'running',
    lastEventAt: event.timestamp,
    lastEventLabel: 'review_invalidated',
  }, 'system');

  return updated?.status === 'running';
}
