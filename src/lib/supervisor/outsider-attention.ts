export type OutsiderAttentionThreadKind = 'issue' | 'pr';

export interface OutsiderAttentionThread {
  repo: string;
  kind: OutsiderAttentionThreadKind;
  number: number;
  url: string;
  title: string;
  state: string;
  closedAt: string | null;
  lastHumanCommentAuthorLogin: string | null;
  lastHumanCommentAuthorAssociation: string | null;
  lastHumanCommentAt: string | null;
  lastInsiderCommentAt: string | null;
}

export interface WaitingOutsider {
  repo: string;
  kind: OutsiderAttentionThreadKind;
  number: number;
  url: string;
  title: string;
  waitingLogin: string;
  waitingSince: string;
  hours: number;
}

export const OUTSIDER_ATTENTION_RECENTLY_CLOSED_MS = 7 * 24 * 60 * 60_000;

const INSIDER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export function isGitHubBotLogin(login: string | null | undefined): boolean {
  return typeof login === 'string' && login.trim().toLowerCase().endsWith('[bot]');
}

export function isGitHubInsiderAssociation(association: string | null | undefined): boolean {
  return INSIDER_ASSOCIATIONS.has(association?.trim().toUpperCase() ?? '');
}

function validTimestamp(value: string | null): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function findWaitingOutsiders(
  threads: OutsiderAttentionThread[],
  now: Date,
  thresholdMs: number,
): WaitingOutsider[] {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) return [];
  const boundedThresholdMs = Math.max(0, thresholdMs);

  return threads.flatMap((thread) => {
    const waitingLogin = thread.lastHumanCommentAuthorLogin?.trim() ?? '';
    const waitingSinceMs = validTimestamp(thread.lastHumanCommentAt);
    if (!waitingLogin || waitingSinceMs === null || isGitHubBotLogin(waitingLogin)) return [];
    if (isGitHubInsiderAssociation(thread.lastHumanCommentAuthorAssociation)) return [];

    if (thread.state.toLowerCase() !== 'open') {
      const closedAtMs = validTimestamp(thread.closedAt);
      if (closedAtMs === null || nowMs - closedAtMs > OUTSIDER_ATTENTION_RECENTLY_CLOSED_MS) return [];
    }

    const lastInsiderCommentMs = validTimestamp(thread.lastInsiderCommentAt);
    if (lastInsiderCommentMs !== null && lastInsiderCommentMs > waitingSinceMs) return [];

    const waitingMs = nowMs - waitingSinceMs;
    if (waitingMs < boundedThresholdMs) return [];

    return [{
      repo: thread.repo,
      kind: thread.kind,
      number: thread.number,
      url: thread.url,
      title: thread.title,
      waitingLogin,
      waitingSince: thread.lastHumanCommentAt!,
      hours: Math.floor(waitingMs / (60 * 60_000)),
    }];
  });
}
