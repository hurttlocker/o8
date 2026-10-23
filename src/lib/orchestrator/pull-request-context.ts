import 'server-only';

import { getSqlite } from '@/lib/db';
import { readPersistedLlmChat } from '@/lib/llm/chat-history-store';

export interface PullRequestContextIdentity {
  host: 'github.com';
  repositoryId: number;
  pullRequestId: number;
  number: number;
}

export interface PullRequestContextLink extends PullRequestContextIdentity {
  id: number;
  threadId: string;
  repositoryFullName: string;
  url: string;
  kind: 'context';
  source: 'operator';
  createdAt: string;
}

export class PullRequestContextError extends Error {
  constructor(public code: string, message: string, public status: number) {
    super(message);
  }
}

function requireThread(threadId: string): void {
  if (!readPersistedLlmChat(threadId)) {
    throw new PullRequestContextError('thread_not_found', 'The conversation was not found.', 404);
  }
}

type ContextRow = Omit<PullRequestContextLink, 'url'> & { providerUrl: string | null };
const SELECT_LINKS = `
  SELECT c.id, c.thread_id AS threadId, c.host, c.repository_id AS repositoryId,
    c.pull_request_id AS pullRequestId, c.number,
    c.repository_name AS repositoryFullName, p.url AS providerUrl,
    c.kind, c.source, c.created_at AS createdAt
  FROM conversation_pr_context c
  LEFT JOIN github_pull_requests p ON p.pull_request_id = c.pull_request_id
    AND p.repository_id = c.repository_id AND p.number = c.number
`;

function githubRepositoryName(providerUrl: string | null, number: number): string | null {
  try {
    const url = new URL(providerUrl ?? '');
    const match = url.pathname.match(/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)\/?$/);
    return url.origin === 'https://github.com' && match && Number(match[3]) === number
      ? `${match[1]}/${match[2]}` : null;
  } catch { return null; }
}

function asLink(row: ContextRow): PullRequestContextLink {
  const { providerUrl, ...link } = row;
  const repositoryFullName = githubRepositoryName(providerUrl, row.number) ?? row.repositoryFullName;
  return { ...link, repositoryFullName, url: `https://${row.host}/${repositoryFullName}/pull/${row.number}` };
}

/** Explicit context only. Branch names and primary delivery PRs never create associations here. */
export function attachPullRequestContext(threadId: string, identity: PullRequestContextIdentity): {
  link: PullRequestContextLink; created: boolean;
} {
  requireThread(threadId);
  const db = getSqlite();
  return db.transaction(() => {
    const mirrored = db.prepare(`
      SELECT p.url AS providerUrl
      FROM github_pull_requests p
      WHERE p.repository_id = ? AND p.pull_request_id = ? AND p.number = ?
    `).get(identity.repositoryId, identity.pullRequestId, identity.number) as {
      providerUrl: string;
    } | undefined;
    const repositoryName = mirrored ? githubRepositoryName(mirrored.providerUrl, identity.number) : null;
    if (!repositoryName || identity.host !== 'github.com') {
      throw new PullRequestContextError('pr_identity_mismatch', 'Refresh the PR mirror, then provide matching GitHub repository and PR identities.', 409);
    }
    const result = db.prepare(`
      INSERT INTO conversation_pr_context
        (thread_id, host, repository_id, pull_request_id, number, repository_name, kind, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'context', 'operator', ?)
      ON CONFLICT(thread_id, host, repository_id, pull_request_id) DO NOTHING
    `).run(threadId, identity.host, identity.repositoryId, identity.pullRequestId, identity.number,
      repositoryName, new Date().toISOString());
    const row = db.prepare(`${SELECT_LINKS}
      WHERE c.thread_id = ? AND c.host = ? AND c.repository_id = ? AND c.pull_request_id = ?
    `).get(threadId, identity.host, identity.repositoryId, identity.pullRequestId) as ContextRow;
    return { link: asLink(row), created: result.changes > 0 };
  }).immediate();
}

export function unlinkPullRequestContext(threadId: string, identity: PullRequestContextIdentity): boolean {
  // Removal uses the durable identity, so deleted history or a stale mirror cannot trap a link.
  return getSqlite().prepare(`
    DELETE FROM conversation_pr_context
    WHERE thread_id = ? AND host = ? AND repository_id = ? AND pull_request_id = ? AND number = ?
  `).run(threadId, identity.host, identity.repositoryId, identity.pullRequestId, identity.number).changes > 0;
}

export function listPullRequestContext(
  target: { threadId: string } | PullRequestContextIdentity,
  page: { after?: number; limit?: number } = {},
): { links: PullRequestContextLink[]; nextCursor: number | null } {
  const after = page.after ?? 0;
  const limit = page.limit ?? 50;
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new PullRequestContextError('invalid_page', 'Use a nonnegative cursor and a limit from 1 to 200.', 400);
  }
  const forward = 'threadId' in target;
  if (forward) requireThread(target.threadId);
  const params = forward ? [target.threadId] : [target.host, target.repositoryId, target.pullRequestId, target.number];
  const where = forward ? 'c.thread_id = ?' : 'c.host = ? AND c.repository_id = ? AND c.pull_request_id = ? AND c.number = ?';
  const rows = getSqlite().prepare(`${SELECT_LINKS} WHERE ${where} AND c.id > ? ORDER BY c.id ASC LIMIT ?`)
    .all(...params, after, limit + 1) as ContextRow[];
  const links = rows.slice(0, limit).map(asLink);
  return { links, nextCursor: rows.length > limit ? links[links.length - 1].id : null };
}
