import type { MobileInboxSnapshot } from '@/lib/mobile/types';

export function filterInboxSnapshotByOpenClaw(
  snapshot: MobileInboxSnapshot,
  includeOpenClaw: boolean,
): MobileInboxSnapshot {
  if (includeOpenClaw) return snapshot;

  const sessions = snapshot.sessions.filter((session) => session.runtime !== 'openclaw');
  const allowedSessionKeys = new Set(sessions.map((session) => session.sessionKey));
  const approvalsList = (snapshot.approvals ?? []).filter((approval) => allowedSessionKeys.has(approval.sessionKey));
  const items = snapshot.items.filter((item) => !item.sessionKey || allowedSessionKeys.has(item.sessionKey));
  const alerts = items.filter((item) => item.kind === 'alert' && item.severity !== 'info').length;
  const approvals = approvalsList.length;
  const reviewItems = items.filter((item) => item.kind === 'review').length;
  const activeRuns = sessions.filter((session) => ['running', 'reviewing', 'blocked', 'waiting', 'failed'].includes(session.status)).length;
  const primarySessionKey = sessions.find((session) => session.sessionKey === snapshot.primarySessionKey)?.sessionKey
    ?? sessions.find((session) => session.status === 'running' || session.status === 'reviewing')?.sessionKey
    ?? sessions[0]?.sessionKey;

  return {
    ...snapshot,
    primarySessionKey,
    sessions,
    approvals: approvalsList,
    items,
    summary: {
      alerts,
      approvals,
      reviewItems,
      activeRuns,
    },
  };
}
