import 'server-only';

import { randomBytes } from 'node:crypto';

interface LlmToolGrant {
  tabId: string;
  repoPath: string;
  toolName: string;
  args: Record<string, unknown>;
  expiresAt: number;
}

const GRANT_TTL_MS = 60_000;
const grants = new Map<string, LlmToolGrant>();

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;

  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalize(record[key])]),
  );
}

export function toolArgsEqual(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function reapExpired(now: number): void {
  for (const [token, grant] of grants) {
    if (grant.expiresAt <= now) grants.delete(token);
  }
}

export function issueLlmToolGrant(input: {
  tabId: string;
  repoPath: string;
  toolName: string;
  args: Record<string, unknown>;
}): string {
  const now = Date.now();
  reapExpired(now);
  const token = randomBytes(32).toString('base64url');
  grants.set(token, {
    tabId: input.tabId,
    repoPath: input.repoPath,
    toolName: input.toolName,
    args: canonicalize(input.args) as Record<string, unknown>,
    expiresAt: now + GRANT_TTL_MS,
  });
  return token;
}

/**
 * Consume a one-shot approval only when the regenerated call has the exact
 * approved arguments. A same-name call with changed arguments burns the grant.
 */
export function consumeLlmToolGrant(input: {
  token: string | null;
  tabId: string;
  repoPath: string;
  toolName: string;
  args: Record<string, unknown>;
}): boolean {
  if (!input.token) return false;
  const now = Date.now();
  reapExpired(now);
  const grant = grants.get(input.token);
  if (!grant) return false;

  if (grant.toolName !== input.toolName) return false;
  grants.delete(input.token);

  return grant.expiresAt > now
    && grant.tabId === input.tabId
    && grant.repoPath === input.repoPath
    && toolArgsEqual(grant.args, input.args);
}

export function clearLlmToolGrantsForTests(): void {
  grants.clear();
}
