import type { SupervisorInboxItem } from '@/lib/supervisor/inbox';
import type { MaintainerContribution } from './maintainer-types';

const activeStatuses = new Set(['pending', 'healing', 'human_required', 'escalated']);
function incidentKey(item: SupervisorInboxItem): string {
  return `${String(item.payload.threadRepo ?? '').toLowerCase()}:${item.payload.threadKind}:${item.payload.threadNumber}`;
}
function replyKey(item: MaintainerContribution): string {
  return `${item.repo.toLowerCase()}:${item.threadKind}:${item.number}`;
}

/** New messages appear immediately; an unchanged dismissed message stays dismissed. */
export function maintainerReplyQueue(incidents: SupervisorInboxItem[], snapshots: MaintainerContribution[]): Array<SupervisorInboxItem | MaintainerContribution> {
  const outside = incidents.filter((item) => item.kind === 'outside_human_waiting');
  const snapshotByKey = new Map(snapshots.map((item) => [replyKey(item), item]));
  const queue: Array<SupervisorInboxItem | MaintainerContribution> = outside.filter((item) => {
    if (!activeStatuses.has(item.status)) return false;
    const snapshot = snapshotByKey.get(incidentKey(item));
    return !snapshot || snapshot.waitingSince === item.payload.waitingSince;
  });
  for (const snapshot of snapshots) {
    if (!outside.some((item) => incidentKey(item) === replyKey(snapshot) && item.payload.waitingSince === snapshot.waitingSince)) queue.push(snapshot);
  }
  return queue.sort((a, b) => {
    const since = (item: SupervisorInboxItem | MaintainerContribution) => 'payload' in item ? String(item.payload.waitingSince ?? item.createdAt) : item.waitingSince ?? item.createdAt;
    return since(a).localeCompare(since(b)) || a.id.localeCompare(b.id);
  });
}
