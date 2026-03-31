import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { promisify } from 'node:util';
import type { OrchestratorReviewFinding } from '@/lib/approvals/types';
import type {
  ApproveAndMergeInput as ApproveAndMergeRequest,
  CreateMissionInput as CreateMissionRequest,
  DispatchMissionInput,
  LoadedIssue,
  MissionStatusInput,
  SubmitReviewInput,
} from '@/lib/orchestrator/operator-mission-service';
import type { OrchestratorRuntime } from '@/lib/orchestrator/types';

const execFileAsync = promisify(execFile);
const GH_MAX_BUFFER = 10 * 1024 * 1024;
const LOG_PREFIX = '[mcp-operator]';
const API_BASE = process.env.O8_API_BASE?.trim() || 'http://localhost:3001';

interface CreateMissionInput {
  issues: string[];
  repoPath: string;
  runtime: OrchestratorRuntime;
  constraints: string;
}

interface ApiSuccessResponse<T> {
  ok: true;
  result: T;
}

interface ApiErrorResponse {
  ok: false;
  error: {
    code?: string;
    message?: string;
  } | string;
}

type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

function log(message: string, details?: unknown) {
  if (details === undefined) {
    console.log(`${LOG_PREFIX} ${message}`);
    return;
  }
  console.log(`${LOG_PREFIX} ${message}`, details);
}

function ensureRepoPath(repoPath: string) {
  const normalized = repoPath.trim();
  if (!normalized) {
    throw new Error('repoPath is required.');
  }
  if (!existsSync(normalized) || !statSync(normalized).isDirectory()) {
    throw new Error(`Repository path not found: ${normalized}`);
  }
  return normalized;
}

function normalizeIssueRef(value: string) {
  const normalized = value.trim();
  if (!normalized) {
    return '';
  }

  const urlMatch = normalized.match(/\/issues\/(\d+)(?:\/)?$/i);
  if (urlMatch?.[1]) {
    return urlMatch[1];
  }

  const hashMatch = normalized.match(/^#?(\d+)$/);
  if (hashMatch?.[1]) {
    return hashMatch[1];
  }

  return normalized;
}

async function loadIssue(repoPath: string, issueRef: string): Promise<LoadedIssue> {
  const normalizedIssueRef = normalizeIssueRef(issueRef);
  if (!normalizedIssueRef) {
    throw new Error('Issue references must be non-empty.');
  }

  const { stdout } = await execFileAsync(
    'gh',
    ['issue', 'view', normalizedIssueRef, '--json', 'number,title,body,url'],
    { cwd: repoPath, maxBuffer: GH_MAX_BUFFER },
  );

  const parsed = JSON.parse(stdout) as Partial<LoadedIssue>;
  if (typeof parsed.number !== 'number' || typeof parsed.title !== 'string') {
    throw new Error(`Unable to load issue ${normalizedIssueRef}.`);
  }

  return {
    number: parsed.number,
    title: parsed.title,
    body: typeof parsed.body === 'string' ? parsed.body : '',
    url: typeof parsed.url === 'string' ? parsed.url : '',
  };
}

function extractApiErrorMessage(path: string, status: number, payload: unknown) {
  if (payload && typeof payload === 'object' && 'error' in payload) {
    const errorValue = (payload as { error: unknown }).error;
    if (typeof errorValue === 'string' && errorValue.trim()) {
      return errorValue;
    }
    if (
      errorValue
      && typeof errorValue === 'object'
      && 'message' in errorValue
      && typeof (errorValue as { message?: unknown }).message === 'string'
    ) {
      return (errorValue as { message: string }).message;
    }
  }

  return `Request to ${path} failed with HTTP ${status}.`;
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...init?.headers,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to reach Next.js API at ${API_BASE}: ${message}`);
  }

  const payload = await response.json().catch(() => null) as ApiResponse<T> | Record<string, unknown> | null;
  if (!response.ok) {
    throw new Error(extractApiErrorMessage(path, response.status, payload));
  }

  if (payload && typeof payload === 'object' && 'ok' in payload) {
    if (payload.ok === true && 'result' in payload) {
      return payload.result as T;
    }

    throw new Error(extractApiErrorMessage(path, response.status, payload));
  }

  throw new Error(`Invalid response from ${path}.`);
}

export async function createMission(input: CreateMissionInput) {
  const repoPath = ensureRepoPath(input.repoPath);
  const loadedIssues = await Promise.all(input.issues.map((issueRef) => loadIssue(repoPath, issueRef)));

  log(`Loaded ${loadedIssues.length} issue${loadedIssues.length === 1 ? '' : 's'} locally; delegating mission creation to Next.js API.`);

  return apiRequest<Awaited<ReturnType<typeof import('@/lib/orchestrator/operator-mission-service').createMission>>>(
    '/api/orchestrator/create-mission',
    {
      method: 'POST',
      body: JSON.stringify({
        issues: loadedIssues,
        repoPath,
        runtime: input.runtime,
        constraints: input.constraints,
      } satisfies CreateMissionRequest),
    },
  );
}

export async function dispatchMission(input: DispatchMissionInput) {
  return apiRequest<Awaited<ReturnType<typeof import('@/lib/orchestrator/operator-mission-service').dispatchMission>>>(
    '/api/orchestrator/dispatch',
    {
      method: 'POST',
      body: JSON.stringify({
        missionId: input.missionId,
      } satisfies DispatchMissionInput),
    },
  );
}

export async function getMissionStatus(input: MissionStatusInput) {
  const params = new URLSearchParams();
  if (input.missionId?.trim()) {
    params.set('missionId', input.missionId.trim());
  }
  if (input.includeCost) {
    params.set('includeCost', 'true');
  }

  const suffix = params.toString() ? `?${params.toString()}` : '';
  return apiRequest<Awaited<ReturnType<typeof import('@/lib/orchestrator/operator-mission-service').getMissionStatus>>>(
    `/api/orchestrator/status${suffix}`,
  );
}

export async function submitPacketReview(input: SubmitReviewInput) {
  return apiRequest<Awaited<ReturnType<typeof import('@/lib/orchestrator/operator-mission-service').submitPacketReview>>>(
    '/api/orchestrator/review',
    {
      method: 'POST',
      body: JSON.stringify({
        packetId: input.packetId,
        findings: input.findings,
        approved: input.approved,
      } satisfies SubmitReviewInput),
    },
  );
}

export async function approveAndMergePacket(input: ApproveAndMergeRequest) {
  return apiRequest<Awaited<ReturnType<typeof import('@/lib/orchestrator/operator-mission-service').approveAndMergePacket>>>(
    '/api/orchestrator/merge',
    {
      method: 'POST',
      body: JSON.stringify({
        packetId: input.packetId,
        commitMessage: input.commitMessage,
      } satisfies ApproveAndMergeRequest),
    },
  );
}

export type { OrchestratorReviewFinding };
