import { createHash } from 'node:crypto';
import { listSessionRules } from '@/lib/db/session-rules-store';
import { readOrchestratorControlPlaneState } from './control-plane';
import { findMissionRegistryEntryByPacketId } from './mission-registry';
import { acquireWorkspaceLifecycleLease, releaseWorkspaceLifecycleLease } from './workspace-lifecycle-lease';

export const SESSION_MERGE_RESTRICTION_NOTE = 'Merge blocked by an operator session rule. Remove the no-merge rule in the originating chat before merging. Existing approvals do not override it.';
export class SessionMergeRestrictionError extends Error {}

/** Share the existing cross-process lifecycle lease between rule edits and publication. */
export async function withSessionRuleMutation<T>(threadId: string, operation: () => T | Promise<T>): Promise<T> {
  const key = `session-rules-${createHash('sha256').update(threadId).digest('hex')}`;
  let lease;
  try { lease = await acquireWorkspaceLifecycleLease(key, { waitForLiveOwner: false }); }
  catch { throw new SessionMergeRestrictionError('A merge publication or session-rule edit is already in progress. The requested operation was not admitted; inspect the result before retrying.'); }
  try { return await operation(); } finally { releaseWorkspaceLifecycleLease(lease); }
}

export function packetRuleThread(packetId: string | null | undefined): string | null {
  if (!packetId) return null;
  const current = readOrchestratorControlPlaneState().packets.find(packet => packet.id === packetId);
  const stored = findMissionRegistryEntryByPacketId(packetId, { includeArchived: true })?.mission.packets.find(packet => packet.id === packetId);
  if (current?.orchestratorThreadId && stored?.orchestratorThreadId && current.orchestratorThreadId !== stored.orchestratorThreadId) {
    throw new SessionMergeRestrictionError('Packet parent identity is inconsistent; merge remains held.');
  }
  return current?.orchestratorThreadId ?? stored?.orchestratorThreadId ?? null;
}

export function assertSessionMergeAllowed(packetId: string | null | undefined): void {
  const threadId = packetRuleThread(packetId);
  if (threadId && listSessionRules(threadId).some(rule => rule.constraint === 'no_merge')) throw new SessionMergeRestrictionError(SESSION_MERGE_RESTRICTION_NOTE);
}

/** All actors pass this boundary, including continuations of previously approved cards. */
export async function withSessionMergePublication<T>(packetId: string | null | undefined, publish: () => Promise<T>): Promise<T> {
  const threadId = packetRuleThread(packetId);
  if (!threadId) return publish();
  return withSessionRuleMutation(threadId, async () => {
    if (packetRuleThread(packetId) !== threadId) throw new SessionMergeRestrictionError('Packet parent changed before merge publication.');
    assertSessionMergeAllowed(packetId);
    return publish();
  });
}
