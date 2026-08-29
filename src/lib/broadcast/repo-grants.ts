import path from 'node:path';

import { normalizeGitRemote } from '@/lib/receipts/verify-receipt';

export const MAX_SPECTATOR_REPO_GRANTS = 100;
const MAX_REPO_GRANT_LENGTH = 2_048;

function normalizedStoredRemote(value: string): string | null {
  const normalized = normalizeGitRemote(value);
  if (normalized) return normalized;
  const segments = value.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  if (segments.length < 3) return null;
  return segments.map((segment, index) => (
    index === segments.length - 1 ? segment.replace(/\.git$/i, '') : segment
  )).join('/').toLowerCase();
}

export function normalizeRepoGrant(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('Repository grants cannot be empty.');
  if (trimmed.length > MAX_REPO_GRANT_LENGTH) {
    throw new Error(`Repository grants must be at most ${MAX_REPO_GRANT_LENGTH} characters.`);
  }
  if (/[\r\n\0]/.test(trimmed)) throw new Error('Repository grants cannot contain control characters.');
  if (path.isAbsolute(trimmed)) return path.resolve(trimmed);
  return normalizedStoredRemote(trimmed) ?? trimmed;
}

export function normalizeRepoGrants(values: readonly string[] | null | undefined): string[] {
  if (!values) return [];
  if (values.length > MAX_SPECTATOR_REPO_GRANTS) {
    throw new Error(`A spectator token can grant at most ${MAX_SPECTATOR_REPO_GRANTS} repositories.`);
  }
  return [...new Set(values.map(normalizeRepoGrant))].sort((left, right) => left.localeCompare(right));
}

export function repoGrantMatchesIdentity(input: {
  grant: string;
  repoName: string;
  repoRemote?: string | null;
  repoPath?: string | null;
}): boolean {
  const normalizedGrant = normalizeRepoGrant(input.grant);
  if (path.isAbsolute(normalizedGrant)) {
    return Boolean(input.repoPath) && path.resolve(input.repoPath!) === normalizedGrant;
  }
  const remote = input.repoRemote ? normalizedStoredRemote(input.repoRemote) : null;
  if (remote && normalizedStoredRemote(normalizedGrant) === remote) return true;
  return normalizedGrant.toLowerCase() === input.repoName.trim().toLowerCase();
}

export function repoGrantMatchesRequest(grant: string, requestedRepo: string): boolean {
  return normalizeRepoGrant(grant).toLowerCase() === normalizeRepoGrant(requestedRepo).toLowerCase();
}
