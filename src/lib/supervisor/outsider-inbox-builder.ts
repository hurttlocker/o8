import { getSqlite } from '@/lib/db';
import { listGitHubAttentionThreads } from '@/lib/github-broker/store';
import { resolveRepoPath } from '@/lib/intake/resolve-repo';
import {
  findWaitingOutsiders,
  type OutsiderAttentionThreadKind,
  type WaitingOutsider,
} from './outsider-attention';

const DEFAULT_WAIT_HOURS = 24;
export const ACTIVE_OUTSIDE_INCIDENT_STATUSES = [
  'pending',
  'healing',
  'human_required',
  'escalated',
] as const;
const ACTIVE_STATUSES = new Set<string>(ACTIVE_OUTSIDE_INCIDENT_STATUSES);

type ExistingOutsideIncident = {
  id: string;
  repo_path: string;
  payload: string;
  status: string;
  created_at: string;
};

type OutsideIncidentPayload = {
  title: string;
  body: string;
  url: string;
  threadRepo: string;
  threadKind: OutsiderAttentionThreadKind;
  threadNumber: number;
  threadTitle: string;
  waitingLogin: string;
  waitingSince: string;
  hours: number;
};

type ReconcileOutsideInboxInput = {
  now?: Date;
  thresholdMs?: number;
  enqueue: (input: {
    repoPath: string;
    kind: 'outside_human_waiting';
    payload: OutsideIncidentPayload;
    status: 'human_required';
  }) => { id: string };
  resolve: (id: string, resolvedAt: string, payload: OutsideIncidentPayload, insiderReplyAt: string) => void;
};

function configuredThresholdMs(): number {
  // TODO(#1881 follow-up): Promote the reply threshold to an operator setting when the operator-defaults seam is available.
  const override = Number(process.env.O8_OUTSIDER_WAIT_HOURS);
  const hours = Number.isFinite(override) && override > 0 ? override : DEFAULT_WAIT_HOURS;
  return hours * 60 * 60_000;
}

function threadKey(repo: string, kind: OutsiderAttentionThreadKind, number: number): string {
  return `${repo}\u0000${kind}\u0000${number}`;
}

export function parseOutsideIncidentPayload(raw: string): OutsideIncidentPayload | null {
  try {
    const payload = JSON.parse(raw) as Partial<OutsideIncidentPayload>;
    if (
      typeof payload.threadRepo === 'string'
      && (payload.threadKind === 'issue' || payload.threadKind === 'pr')
      && typeof payload.threadNumber === 'number'
      && typeof payload.waitingSince === 'string'
    ) {
      return payload as OutsideIncidentPayload;
    }
  } catch {
    // A malformed historical row must not block the rest of the inbox pass.
  }
  return null;
}

function incidentPayload(waiting: WaitingOutsider): OutsideIncidentPayload {
  return {
    title: `${waiting.waitingLogin} is waiting on ${waiting.repo}#${waiting.number}`,
    body: `${waiting.title} · waiting ${waiting.hours}h`,
    url: waiting.url,
    threadRepo: waiting.repo,
    threadKind: waiting.kind,
    threadNumber: waiting.number,
    threadTitle: waiting.title,
    waitingLogin: waiting.waitingLogin,
    waitingSince: waiting.waitingSince,
    hours: waiting.hours,
  };
}

export function reconcileOutsideHumanWaitingInbox(input: ReconcileOutsideInboxInput): {
  created: number;
  resolved: number;
} {
  const now = input.now ?? new Date();
  const thresholdMs = input.thresholdMs ?? configuredThresholdMs();
  const threads = listGitHubAttentionThreads();
  const waiting = findWaitingOutsiders(threads, now, thresholdMs);
  const rows = getSqlite().prepare(`
    SELECT id, repo_path, payload, status, created_at
    FROM supervisor_inbox
    WHERE kind = 'outside_human_waiting'
    ORDER BY datetime(created_at) DESC
  `).all() as ExistingOutsideIncident[];

  const latestByThread = new Map<string, { row: ExistingOutsideIncident; payload: OutsideIncidentPayload }>();
  const activeByThread = new Map<string, { row: ExistingOutsideIncident; payload: OutsideIncidentPayload }>();
  for (const row of rows) {
    const payload = parseOutsideIncidentPayload(row.payload);
    if (!payload) continue;
    const key = threadKey(payload.threadRepo, payload.threadKind, payload.threadNumber);
    if (!latestByThread.has(key)) latestByThread.set(key, { row, payload });
    if (ACTIVE_STATUSES.has(row.status) && !activeByThread.has(key)) {
      activeByThread.set(key, { row, payload });
    }
  }

  const waitingKeys = new Set<string>();
  const localRepoPaths = new Map<string, string | null>();
  let created = 0;
  for (const candidate of waiting) {
    if (!localRepoPaths.has(candidate.repo)) {
      localRepoPaths.set(candidate.repo, resolveRepoPath(candidate.repo));
    }
    const repoPath = localRepoPaths.get(candidate.repo);
    if (!repoPath) continue;
    const key = threadKey(candidate.repo, candidate.kind, candidate.number);
    waitingKeys.add(key);
    const payload = incidentPayload(candidate);
    const active = activeByThread.get(key);
    if (active) {
      getSqlite().prepare('UPDATE supervisor_inbox SET payload = ? WHERE id = ?')
        .run(JSON.stringify(payload), active.row.id);
      continue;
    }

    const latest = latestByThread.get(key);
    if (latest?.payload.waitingSince === candidate.waitingSince) continue;
    input.enqueue({
      repoPath,
      kind: 'outside_human_waiting',
      payload,
      status: 'human_required',
    });
    created += 1;
  }

  const threadByKey = new Map(threads.map((thread) => [
    threadKey(thread.repo, thread.kind, thread.number),
    thread,
  ]));
  let resolved = 0;
  for (const [key, active] of activeByThread) {
    if (waitingKeys.has(key)) continue;
    const thread = threadByKey.get(key);
    const insiderReplyMs = thread?.lastInsiderCommentAt
      ? Date.parse(thread.lastInsiderCommentAt)
      : Number.NaN;
    const waitingSinceMs = Date.parse(active.payload.waitingSince);
    if (!Number.isFinite(insiderReplyMs) || insiderReplyMs <= waitingSinceMs) continue;
    input.resolve(active.row.id, now.toISOString(), active.payload, thread!.lastInsiderCommentAt!);
    resolved += 1;
  }

  return { created, resolved };
}
