import path from 'node:path';

import { normalizeGitRemote } from '@/lib/receipts/verify-receipt';

export const MAX_SPECTATOR_REPO_GRANTS = 100;
const MAX_REPO_GRANT_LENGTH = 2_048;
const NAME_GRANT_PREFIX = 'name:';

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
  if (trimmed.toLowerCase().startsWith(NAME_GRANT_PREFIX)) {
    const repoName = trimmed.slice(NAME_GRANT_PREFIX.length).trim();
    if (!repoName || repoName === '.' || repoName === '..' || /[\\/]/.test(repoName)) {
      throw new Error('Name grants must use name:<repo> with one repository name.');
    }
    return `${NAME_GRANT_PREFIX}${repoName.toLowerCase()}`;
  }
  if (path.isAbsolute(trimmed)) return path.resolve(trimmed);
  return normalizedStoredRemote(trimmed) ?? trimmed;
}

export function repoNameFromGrant(grant: string): string | null {
  const normalized = normalizeRepoGrant(grant);
  return normalized.startsWith(NAME_GRANT_PREFIX)
    ? normalized.slice(NAME_GRANT_PREFIX.length)
    : null;
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
  registeredRepoPath?: string | null;
}): boolean {
  const normalizedGrant = normalizeRepoGrant(input.grant);
  if (path.isAbsolute(normalizedGrant)) {
    return Boolean(input.repoPath) && path.resolve(input.repoPath!) === normalizedGrant;
  }
  const nameGrant = repoNameFromGrant(normalizedGrant);
  if (nameGrant) {
    return !input.repoRemote?.trim()
      && input.repoName.trim().toLowerCase() === nameGrant
      && Boolean(input.repoPath)
      && Boolean(input.registeredRepoPath)
      && path.resolve(input.repoPath!) === path.resolve(input.registeredRepoPath!);
  }
  const remote = input.repoRemote ? normalizedStoredRemote(input.repoRemote) : null;
  if (remote && normalizedStoredRemote(normalizedGrant) === remote) return true;
  return false;
}

export function repoGrantMatchesRequest(input: {
  grant: string;
  requestedRepo: string;
  registeredRepoPath?: string | null;
}): boolean {
  const normalizedGrant = normalizeRepoGrant(input.grant);
  const normalizedRequest = normalizeRepoGrant(input.requestedRepo);
  const nameGrant = repoNameFromGrant(normalizedGrant);
  if (nameGrant) {
    if (!input.registeredRepoPath) return false;
    if (path.isAbsolute(normalizedRequest)) {
      return path.resolve(normalizedRequest) === path.resolve(input.registeredRepoPath);
    }
    return normalizedRequest === nameGrant || normalizedRequest === normalizedGrant;
  }
  if (path.isAbsolute(normalizedGrant)) {
    return path.isAbsolute(normalizedRequest)
      && path.resolve(normalizedGrant) === path.resolve(normalizedRequest);
  }
  const grantRemote = normalizedStoredRemote(normalizedGrant);
  return Boolean(grantRemote) && grantRemote === normalizedStoredRemote(normalizedRequest);
}
