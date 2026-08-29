import { NextRequest, NextResponse } from 'next/server';

import { resolveRequestPrincipalContext } from '@/lib/auth/principal';
import {
  receiptCoveredByRepoGrants,
  repoGrantsCoverRequestedRepo,
  resolveTruthQuery,
  TruthQueryError,
  type TruthQuery,
} from '@/lib/receipts/truth-query';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const JSON_HEADERS = { 'Cache-Control': 'no-store, max-age=0' };

function truthError(code: string, message: string, status: number): NextResponse {
  return NextResponse.json({
    schema: 'o8/truth.error/v1',
    ok: false,
    error: { code, message },
  }, { status, headers: JSON_HEADERS });
}

function parseOptionalPositiveInteger(value: string | null, field: string): number | undefined {
  if (value === null) return undefined;
  if (!/^\d+$/.test(value)) throw new TruthQueryError('invalid_query', `${field} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new TruthQueryError('invalid_query', `${field} must be a positive integer.`);
  }
  return parsed;
}

function parseQuery(request: NextRequest): TruthQuery {
  const params = request.nextUrl.searchParams;
  const kind = params.get('kind')?.trim();
  const limit = parseOptionalPositiveInteger(params.get('limit'), 'limit');
  const cursor = params.get('cursor');
  if (kind === 'merged-since') {
    const repo = params.get('repo')?.trim() ?? '';
    const since = params.get('since')?.trim() ?? '';
    if (!repo) throw new TruthQueryError('invalid_query', 'repo is required.');
    if (!since) throw new TruthQueryError('invalid_query', 'since is required.');
    return {
      kind,
      repo,
      since,
      limit,
      cursor,
    };
  }
  if (kind === 'packet') {
    return {
      kind,
      packetId: params.get('packetId')?.trim() || undefined,
      issueNumber: parseOptionalPositiveInteger(params.get('issueNumber'), 'issueNumber'),
      limit,
      cursor,
    };
  }
  if (kind === 'approvals') {
    return {
      kind,
      packetId: params.get('packetId')?.trim() ?? '',
      limit,
      cursor,
    };
  }
  throw new TruthQueryError(
    'invalid_query',
    'kind must be merged-since, packet, or approvals.',
  );
}

export async function GET(request: NextRequest) {
  const principal = resolveRequestPrincipalContext(request);
  if (principal.role !== 'operator' && principal.role !== 'spectator') {
    return truthError('truth_reader_forbidden', 'Truth queries require an operator or spectator credential.', 403);
  }
  if (principal.role === 'spectator' && principal.repoGrants.length === 0) {
    return truthError(
      'spectator_repo_grants_required',
      'Truth queries require at least one repository grant.',
      403,
    );
  }

  try {
    const query = parseQuery(request);
    if (
      principal.role === 'spectator'
      && query.kind === 'merged-since'
      && !repoGrantsCoverRequestedRepo(principal.repoGrants, query.repo)
    ) {
      return truthError(
        'spectator_repo_forbidden',
        'The spectator credential is not granted to the requested repository.',
        403,
      );
    }
    const result = resolveTruthQuery(query, principal.role === 'spectator'
      ? {
          receiptFilter: (receipt) => receiptCoveredByRepoGrants(receipt, principal.repoGrants),
        }
      : {});
    return NextResponse.json(result, { headers: JSON_HEADERS });
  } catch (error) {
    if (error instanceof TruthQueryError) return truthError(error.code, error.message, 400);
    console.error('[truth] Query failed:', error);
    return truthError('truth_query_failed', 'The truth query could not be completed.', 500);
  }
}
