import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { promisify } from 'node:util';
import { sanitizeErrorMessage } from '@/lib/api/error-format';
import type { OrchestratorReviewFinding } from '@/lib/approvals/types';
import type {
  ApproveAndMergeInput as ApproveAndMergeRequest,
  CreateMissionInput as CreateMissionRequest,
  DispatchMissionInput,
  LoadedIssue,
  MissionStatusInput,
  ResetPacketInput,
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
  sequential?: boolean;
}

interface InlineIssue {
  number: number;
  title: string;
  body?: string;
}

interface CreateMissionInlineInput {
  issues_inline: InlineIssue[];
  repoPath: string;
  runtime: OrchestratorRuntime;
  constraints: string;
  sequential?: boolean;
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
type MissionToolError = { error: string };

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

const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [500, 1500, 4000];
const FETCH_TIMEOUT_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response | undefined;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];
      log(`API retry ${attempt}/${MAX_RETRIES} for ${path} in ${delay}ms`);
      await sleep(delay);
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      response = await fetch(`${API_BASE}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...init?.headers,
        },
      });
      clearTimeout(timer);
      break;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (lastError.name === 'AbortError') {
        lastError = new Error(`Request to ${path} timed out after ${FETCH_TIMEOUT_MS}ms`);
      }
      response = undefined;
    }
  }

  if (!response) {
    throw new Error(`o8 API unreachable after ${MAX_RETRIES} retries (${path}): ${lastError?.message ?? 'unknown'}. Is the dev server running on ${API_BASE}?`);
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

function missionToolError(action: string, error: unknown, fallback: string): MissionToolError {
  console.error(`${LOG_PREFIX} ${action} failed`, error);
  return { error: sanitizeErrorMessage(error, fallback) };
}

export async function createMission(input: CreateMissionInput) {
  try {
    const repoPath = ensureRepoPath(input.repoPath);
    const loadedIssues = await Promise.all(input.issues.map((issueRef) => loadIssue(repoPath, issueRef)));

    log(`Loaded ${loadedIssues.length} issue${loadedIssues.length === 1 ? '' : 's'} locally; delegating mission creation to Next.js API.`);

    return await apiRequest<Awaited<ReturnType<typeof import('@/lib/orchestrator/operator-mission-service').createMission>>>(
      '/api/orchestrator/create-mission',
      {
        method: 'POST',
        body: JSON.stringify({
          issues: loadedIssues,
          repoPath,
          runtime: input.runtime,
          constraints: input.constraints,
          sequential: input.sequential,
        } satisfies CreateMissionRequest),
      },
    );
  } catch (error) {
    return missionToolError('createMission', error, 'Failed to create mission.');
  }
}

/**
 * #453 — Create a mission from inline issue objects, bypassing `gh issue view`.
 * Use when GitHub API is rate-limited or issues are ad-hoc/synthetic.
 */
export async function createMissionInline(input: CreateMissionInlineInput) {
  try {
    const repoPath = ensureRepoPath(input.repoPath);

    const loadedIssues: LoadedIssue[] = input.issues_inline.map((issue) => ({
      number: issue.number,
      title: issue.title,
      body: issue.body ?? '',
      url: '',
    }));

    log(`Creating mission from ${loadedIssues.length} inline issue${loadedIssues.length === 1 ? '' : 's'} (no GitHub fetch).`);

    return await apiRequest<Awaited<ReturnType<typeof import('@/lib/orchestrator/operator-mission-service').createMission>>>(
      '/api/orchestrator/create-mission',
      {
        method: 'POST',
        body: JSON.stringify({
          issues: loadedIssues,
          repoPath,
          runtime: input.runtime,
          constraints: input.constraints,
          sequential: input.sequential,
        } satisfies CreateMissionRequest),
      },
    );
  } catch (error) {
    return missionToolError('createMissionInline', error, 'Failed to create mission.');
  }
}

export async function dispatchMission(input: DispatchMissionInput) {
  try {
    return await apiRequest<Awaited<ReturnType<typeof import('@/lib/orchestrator/operator-mission-service').dispatchMission>>>(
      '/api/orchestrator/dispatch',
      {
        method: 'POST',
        body: JSON.stringify({
          missionId: input.missionId,
        } satisfies DispatchMissionInput),
      },
    );
  } catch (error) {
    return missionToolError('dispatchMission', error, 'Failed to dispatch mission.');
  }
}

export async function getMissionStatus(input: MissionStatusInput) {
  try {
    const params = new URLSearchParams();
    if (input.missionId?.trim()) {
      params.set('missionId', input.missionId.trim());
    }
    if (input.includeCost) {
      params.set('includeCost', 'true');
    }

    const suffix = params.toString() ? `?${params.toString()}` : '';
    return await apiRequest<Awaited<ReturnType<typeof import('@/lib/orchestrator/operator-mission-service').getMissionStatus>>>(
      `/api/orchestrator/status${suffix}`,
    );
  } catch (error) {
    return missionToolError('getMissionStatus', error, 'Failed to read mission status.');
  }
}

export async function submitPacketReview(input: SubmitReviewInput) {
  try {
    return await apiRequest<Awaited<ReturnType<typeof import('@/lib/orchestrator/operator-mission-service').submitPacketReview>>>(
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
  } catch (error) {
    return missionToolError('submitPacketReview', error, 'Failed to submit review.');
  }
}

export async function approveAndMergePacket(input: ApproveAndMergeRequest) {
  try {
    return await apiRequest<Awaited<ReturnType<typeof import('@/lib/orchestrator/operator-mission-service').approveAndMergePacket>>>(
      '/api/orchestrator/merge',
      {
        method: 'POST',
        body: JSON.stringify({
          packetId: input.packetId,
          commitMessage: input.commitMessage,
        } satisfies ApproveAndMergeRequest),
      },
    );
  } catch (error) {
    return missionToolError('approveAndMergePacket', error, 'Failed to approve and merge packet.');
  }
}

export async function resetPacket(input: ResetPacketInput) {
  try {
    return await apiRequest<Awaited<ReturnType<typeof import('@/lib/orchestrator/operator-mission-service').resetPacket>>>(
      '/api/orchestrator/reset-packet',
      {
        method: 'POST',
        body: JSON.stringify({
          packetId: input.packetId,
          reason: input.reason,
          clearWorktree: input.clearWorktree,
        } satisfies ResetPacketInput),
      },
    );
  } catch (error) {
    return missionToolError('resetPacket', error, 'Failed to reset packet.');
  }
}

export type { OrchestratorReviewFinding };
