import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { sanitizeErrorMessage } from '@/lib/api/error-format';
import { DEFAULT_API_PORT } from '@/lib/panel/api-port';
import { pollCorrelatedMcpMutation } from '@/lib/mcp/correlated-mutation';
import type { CorrelatedActionPayload } from '@/lib/orchestrator/action-receipt';

/**
 * Resolve the backend base URL from env, port file, or legacy default.
 * Kept inline (small dupe with operator-mcp-server.ts) because this file
 * is also imported from the Next server where getApiBase() is available,
 * but the MCP-spawn path needs a plain function without Next-specific deps.
 */
function resolveApiBase(): string {
  // Precedence: api-port FILE first (always reflects the running app),
  // then env vars (Tauri sidecar children), then legacy default.
  // The file is the only signal that survives env staleness across dev /
  // prod port swaps, app restarts, and Claude Code parent shells whose
  // O8_API_BASE was set before a port change. Env-var-first was the old
  // order and stuck MCP on dead ports across the dev-frontend swap.
  try {
    const dataDir = getDataDir();
    const portFile = join(dataDir, 'api-port');
    if (existsSync(portFile)) {
      const n = parseInt(readFileSync(portFile, 'utf-8').trim(), 10);
      if (Number.isInteger(n) && n > 0 && n < 65536) {
        return `http://127.0.0.1:${n}`;
      }
    }
  } catch { /* fall through */ }
  const envBase = process.env.O8_API_BASE?.trim();
  if (envBase) return envBase;
  const envPort = process.env.O8_API_PORT?.trim();
  if (envPort) return `http://127.0.0.1:${envPort}`;
  return `http://localhost:${DEFAULT_API_PORT}`;
}

// ── Panel Bearer token ──
//
// Same pattern as operator-handlers/shared.ts: the middleware's loopback
// bypass doesn't trigger reliably for plain Node fetch from this MCP path
// (no Origin / sec-fetch-site headers). Adding `Authorization: Bearer
// <ws-token>` is belt-and-suspenders. Without this, MCP create_mission /
// dispatch / status calls return 401 from the gated /api/orchestrator/*
// routes even though the loopback origin should pass.
let _cachedPanelToken: { value: string; readAt: number } | null = null;
const PANEL_TOKEN_TTL_MS = 30_000;

function readPanelToken(): string | null {
  const now = Date.now();
  if (_cachedPanelToken && now - _cachedPanelToken.readAt < PANEL_TOKEN_TTL_MS) {
    return _cachedPanelToken.value || null;
  }
  try {
    const dataDir = getDataDir();
    const tokenPath = join(dataDir, 'ws-token');
    if (!existsSync(tokenPath)) {
      _cachedPanelToken = { value: '', readAt: now };
      return null;
    }
    const value = readFileSync(tokenPath, 'utf-8').trim();
    _cachedPanelToken = { value, readAt: now };
    return value || null;
  } catch {
    return null;
  }
}
import type { OrchestratorReviewFinding } from '@/lib/approvals/types';
import type {
  ApproveAndMergeInput as ApproveAndMergeRequest,
  CreateMissionInput as CreateMissionRequest,
  DispatchMissionInput,
  ExistingBranchPolicy,
  LoadedIssue,
  MissionStatusInput,
  ResetPacketInput,
  RerunWithFeedbackInput,
  SubmitReviewInput,
} from '@/lib/orchestrator/operator-mission-service';
import type { OrchestratorRuntime, PacketTaskContract, WorkerIntent, WorkerProvider } from '@/lib/orchestrator/types';
import { getDataDir } from '@/lib/data-dir-migration';

const execFileAsync = promisify(execFile);
const GH_MAX_BUFFER = 10 * 1024 * 1024;
const LOG_PREFIX = '[mcp-operator]';

// Re-resolve API base on every call (with a 1s cache to avoid file-stat
// hammering inside hot fetch loops). The constant-at-boot pattern was a
// trap: when the prod app rewrites api-port AFTER the MCP server boots
// (e.g. dev-bridge launching, prod app port-probing past 3001), the
// cached value is stale and every fetch hits a dead port.
let _cachedApiBase: { value: string; ts: number } | null = null;
function getApiBaseLive(): string {
  const now = Date.now();
  if (_cachedApiBase && now - _cachedApiBase.ts < 1000) return _cachedApiBase.value;
  const value = resolveApiBase();
  _cachedApiBase = { value, ts: now };
  return value;
}

interface CreateMissionInput {
  issues: string[];
  repoPath: string;
  runtime: OrchestratorRuntime;
  workerIntent?: WorkerIntent;
  requestedProvider?: WorkerProvider | null;
  requestedRuntime?: OrchestratorRuntime | null;
  requestedModel?: string | null;
  constraints: string;
  sequential?: boolean;
  existingBranchPolicy?: ExistingBranchPolicy;
  useBrain?: boolean;
  huddle?: boolean;
  /** Best-of-N (item 3) — forwarded to the create-mission API, clamped ≤4 there. */
  comparisonModels?: string[];
  qualitySearch?: { taskContract: PacketTaskContract };
  /** #1329 — the orchestrator's active thread id, so workers inherit its session rules. */
  orchestratorThreadId?: string;
  parentWorkspaceId?: string;
  caller?: string;
  readOnly?: boolean;
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
  workerIntent?: WorkerIntent;
  requestedProvider?: WorkerProvider | null;
  requestedRuntime?: OrchestratorRuntime | null;
  requestedModel?: string | null;
  constraints: string;
  sequential?: boolean;
  existingBranchPolicy?: ExistingBranchPolicy;
  useBrain?: boolean;
  huddle?: boolean;
  /** Best-of-N (item 3) — forwarded to the create-mission API, clamped ≤4 there. */
  comparisonModels?: string[];
  qualitySearch?: { taskContract: PacketTaskContract };
  /** #1329 — the orchestrator's active thread id, so workers inherit its session rules. */
  orchestratorThreadId?: string;
  parentWorkspaceId?: string;
  caller?: string;
  readOnly?: boolean;
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

  // The authenticated operator MCP is allowed to dispatch against an explicit
  // local path without mutating Projects. The server still owns worktree,
  // runtime, and governance validation for the resulting transient mission.
  return normalized;
}

function missionLaunchContext(input: {
  orchestratorThreadId?: string;
  parentWorkspaceId?: string;
  caller?: string;
  readOnly?: boolean;
}) {
  const inAppOrchestrator = Boolean(input.orchestratorThreadId?.trim());
  return {
    source: inAppOrchestrator ? 'desktop' as const : 'mcp' as const,
    presentation: inAppOrchestrator ? 'tab' as const : 'split' as const,
    repoContext: inAppOrchestrator ? 'registered' as const : 'transient' as const,
    ...(input.readOnly ? { workMode: 'read-only' as const } : {}),
    caller: input.caller?.trim() || (inAppOrchestrator ? 'orchestrator' : 'external agent'),
    ...(input.parentWorkspaceId?.trim() ? { parentWorkspaceId: input.parentWorkspaceId.trim() } : {}),
    ...(input.orchestratorThreadId?.trim() ? { parentThreadId: input.orchestratorThreadId.trim() } : {}),
  };
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
    { windowsHide: true, cwd: repoPath, maxBuffer: GH_MAX_BUFFER },
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
      const panelToken = readPanelToken();
      const baseHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      if (panelToken) baseHeaders.Authorization = `Bearer ${panelToken}`;
      response = await fetch(`${getApiBaseLive()}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          ...baseHeaders,
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
    throw new Error(
      `o8 API unreachable after ${MAX_RETRIES} retries (${path}): ${lastError?.message ?? 'unknown'}. ` +
      `Expected the o8 backend at ${getApiBaseLive()}. ` +
      `Open the o8 desktop app or run \`npm run desktop:dev\` from the o8 repo.`,
    );
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

async function correlatedApiRequest<T>(
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const payload = await pollCorrelatedMcpMutation<ApiResponse<T> & CorrelatedActionPayload>({
    body,
    correlationField: 'idempotencyKey',
    send: async (requestBody) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const panelToken = readPanelToken();
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (panelToken) headers.Authorization = `Bearer ${panelToken}`;
      try {
        return await fetch(`${getApiBaseLive()}${path}`, {
          method: 'POST',
          headers,
          body: requestBody,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    },
    parseError: (response, responsePayload) => new Error(
      extractApiErrorMessage(path, response.status, responsePayload),
    ),
  });
  if (payload.ok === true && 'result' in payload) return payload.result as T;
  throw new Error(extractApiErrorMessage(path, 200, payload));
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

    return await correlatedApiRequest<Awaited<ReturnType<typeof import('@/lib/orchestrator/operator-mission-service').createMission>>>(
      '/api/orchestrator/create-mission',
      {
          issues: loadedIssues,
          repoPath,
          runtime: input.runtime,
          workerIntent: input.workerIntent,
          requestedProvider: input.requestedProvider,
          requestedRuntime: input.requestedRuntime,
          requestedModel: input.requestedModel,
          constraints: input.constraints,
          sequential: input.sequential,
          existingBranchPolicy: input.existingBranchPolicy,
          useBrain: input.useBrain,
          huddle: input.huddle,
          comparisonModels: input.comparisonModels,
          qualitySearch: input.qualitySearch,
          orchestratorThreadId: input.orchestratorThreadId,
          dispatcher: { surface: 'orchestrator', id: input.orchestratorThreadId ?? 'operator-mcp' },
          launchContext: missionLaunchContext(input),
        } satisfies CreateMissionRequest,
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

    return await correlatedApiRequest<Awaited<ReturnType<typeof import('@/lib/orchestrator/operator-mission-service').createMission>>>(
      '/api/orchestrator/create-mission',
      {
          issues: loadedIssues,
          repoPath,
          runtime: input.runtime,
          workerIntent: input.workerIntent,
          requestedProvider: input.requestedProvider,
          requestedRuntime: input.requestedRuntime,
          requestedModel: input.requestedModel,
          constraints: input.constraints,
          sequential: input.sequential,
          existingBranchPolicy: input.existingBranchPolicy,
          useBrain: input.useBrain,
          huddle: input.huddle,
          comparisonModels: input.comparisonModels,
          qualitySearch: input.qualitySearch,
          orchestratorThreadId: input.orchestratorThreadId,
          dispatcher: { surface: 'orchestrator', id: input.orchestratorThreadId ?? 'operator-mcp' },
          launchContext: missionLaunchContext(input),
        } satisfies CreateMissionRequest,
    );
  } catch (error) {
    return missionToolError('createMissionInline', error, 'Failed to create mission.');
  }
}

export async function dispatchMission(input: DispatchMissionInput) {
  try {
    return await correlatedApiRequest<Awaited<ReturnType<typeof import('@/lib/orchestrator/operator-mission-service').dispatchMission>>>(
      '/api/orchestrator/dispatch',
      { missionId: input.missionId, runtime: input.runtime },
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
    if (input.includeTiming) {
      params.set('includeTiming', 'true');
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
    return await correlatedApiRequest<Awaited<ReturnType<typeof import('@/lib/orchestrator/operator-mission-service').submitPacketReview>>>(
      '/api/orchestrator/review',
      {
        packetId: input.packetId,
        findings: input.findings,
        approved: input.approved,
        reviewedHeadSha: input.reviewedHeadSha,
        contractCoverageEvidence: input.contractCoverageEvidence,
      },
    );
  } catch (error) {
    return missionToolError('submitPacketReview', error, 'Failed to submit review.');
  }
}

export async function approveAndMergePacket(input: ApproveAndMergeRequest) {
  try {
    return await correlatedApiRequest<Awaited<ReturnType<typeof import('@/lib/orchestrator/operator-mission-service').approveAndMergePacket>>>(
      '/api/orchestrator/merge',
      {
        packetId: input.packetId,
        commitMessage: input.commitMessage,
        expectedHeadSha: input.expectedHeadSha,
      },
    );
  } catch (error) {
    return missionToolError('approveAndMergePacket', error, 'Failed to approve and merge packet.');
  }
}

export async function resetPacket(input: ResetPacketInput) {
  try {
    return await correlatedApiRequest<Awaited<ReturnType<typeof import('@/lib/orchestrator/operator-mission-service').resetPacket>>>(
      '/api/orchestrator/reset-packet',
      {
        packetId: input.packetId,
        reason: input.reason,
        clearWorktree: input.clearWorktree,
      },
    );
  } catch (error) {
    return missionToolError('resetPacket', error, 'Failed to reset packet.');
  }
}

export async function rerunWithFeedback(input: RerunWithFeedbackInput) {
  try {
    return await correlatedApiRequest<Awaited<ReturnType<typeof import('@/lib/orchestrator/operator-mission-service').rerunWithFeedback>>>(
      '/api/orchestrator/rerun-with-feedback',
      {
        packetId: input.packetId,
        feedback: input.feedback,
      },
    );
  } catch (error) {
    return missionToolError('rerunWithFeedback', error, 'Failed to rerun packet with feedback.');
  }
}

export type { OrchestratorReviewFinding };
