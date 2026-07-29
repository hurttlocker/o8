import { NextRequest } from 'next/server';
import { requestOrchestratorSessionReset } from '@/lib/lane/orchestrator-session';
import { requirePanelAuth } from '@/lib/panel/auth';
import { listRepos } from '@/lib/repos/registry';
import { resolveOrchestratorRepoPath } from '@/lib/orchestrator/repo-path';
import { asRecord, operatorError, operatorSuccess, parseJsonBody } from '../_utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function resolveRepoPath(value: unknown): Promise<string | null> {
  const explicitRepoPath = typeof value === 'string' ? value.trim() : '';
  if (explicitRepoPath) {
    return resolveOrchestratorRepoPath(explicitRepoPath);
  }

  const repos = await listRepos().catch(() => []);
  return repos.length === 1 ? repos[0]?.localPath?.trim() ?? null : null;
}

function normalizeThreadId(value: unknown): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.startsWith('thoughts-') ? trimmed : null;
}

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const body = await parseJsonBody(request);
  const record = asRecord(body);
  const repoPath = await resolveRepoPath(record?.repoPath);
  if (!repoPath) {
    return operatorError(
      'invalid_request',
      'repoPath is required unless there is exactly one registered repository.',
      400,
    );
  }

  try {
    const result = requestOrchestratorSessionReset(repoPath, normalizeThreadId(record?.threadId));
    return operatorSuccess(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to reset orchestrator session.';
    return operatorError('reset_session_failed', message, 500, error);
  }
}
