import type {
  MobileOrchestratorBackend,
  MobileOrchestratorThread,
} from '@/lib/mobile/types';

export interface CreateMobileOrchestratorThreadInput {
  repoPath: string;
  repoName?: string | null;
  repoBranch?: string | null;
  backend?: MobileOrchestratorBackend | null;
  agent?: string | null;
}

type MobileThreadFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export async function createMobileOrchestratorThreadFromRepo(
  input: CreateMobileOrchestratorThreadInput,
  options: {
    token?: string | null;
    fetchImpl?: MobileThreadFetch;
  } = {},
): Promise<MobileOrchestratorThread> {
  const repoPath = input.repoPath.trim();
  if (!repoPath) {
    throw new Error('Choose a repository first.');
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl('/api/mobile/orchestrator/threads', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      repoPath,
      repoName: input.repoName ?? undefined,
      repoBranch: input.repoBranch ?? undefined,
      backend: input.backend ?? undefined,
      agent: input.agent ?? undefined,
    }),
  });
  const payload = await response.json().catch(() => null) as {
    thread?: MobileOrchestratorThread;
    error?: string;
  } | null;
  if (!response.ok || !payload?.thread) {
    throw new Error(payload?.error ?? `Unable to create conversation (HTTP ${response.status}).`);
  }
  return payload.thread;
}
