import { NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { resolveWorkerRouting } from '@/lib/agents/routing';
import { createMission, type ExistingBranchPolicy, type LoadedIssue } from '@/lib/orchestrator/operator-mission-service';
import { getOperatorDefaultsSync, resolveDefaultDispatchRuntimeSync } from '@/lib/operator/defaults';
import { isSingleSubCheapTierWorker, resolveSubscriptionProfileRouting } from '@/lib/operator/subscription-profile';
import { isThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import type { OrchestratorRuntime } from '@/lib/orchestrator/types';
import { getRuntimeCapability } from '@/lib/orchestrator/runtime-capabilities';
import { assertRuntimeDispatchable, DispatchPreflightError } from '@/lib/runtimes/shared/auth-detect';
import { ControlPlaneLockTimeoutError } from '@/lib/orchestrator/control-plane';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import type { PacketDispatcherAttribution } from '@/lib/orchestrator/types';
import { asRecord, operatorError, operatorSuccess, parseJsonBody } from '../_utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_REQUESTED_RUNTIMES = new Set<OrchestratorRuntime>(['codex', 'claude-code', 'gemini', 'antigravity', 'opencode', 'cursor', 'grok', 'pi']);
const VALID_EXISTING_BRANCH_POLICIES = new Set<ExistingBranchPolicy>(['auto', 'reset', 'continue', 'error']);

function normalizeRuntime(value: unknown): OrchestratorRuntime | null {
  if (typeof value === 'string' && VALID_REQUESTED_RUNTIMES.has(value as OrchestratorRuntime)) {
    return value as OrchestratorRuntime;
  }
  return null;
}

function normalizeIssues(value: unknown): LoadedIssue[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }

  return value.map((issue) => {
    const record = asRecord(issue);
    const perIssueRuntime = normalizeRuntime(record?.runtime);
    return {
      number: typeof record?.number === 'number' ? record.number : Number.NaN,
      title: typeof record?.title === 'string' ? record.title : '',
      body: typeof record?.body === 'string' ? record.body : '',
      url: typeof record?.url === 'string' ? record.url : '',
      ...(perIssueRuntime ? { runtime: perIssueRuntime } : {}),
    };
  });
}

function normalizeExistingBranchPolicy(value: unknown): ExistingBranchPolicy | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return VALID_EXISTING_BRANCH_POLICIES.has(value as ExistingBranchPolicy)
    ? value as ExistingBranchPolicy
    : undefined;
}

function runtimeDispatchError(runtime: OrchestratorRuntime) {
  const cap = getRuntimeCapability(runtime);
  if (cap.dispatchable) return null;
  return operatorError('runtime_not_dispatchable', `${cap.label} is not available for new dispatch. ${cap.description}`, 400, {
    runtime,
    dispatchable: false,
  });
}

// Best-of-N (item 3): the seed packet's comparison models. Clamp to ≤4 so the
// N-up matrix stays honest at the panel's max width; empty → undefined (no fan-out).
const MAX_COMPARISON_MODELS = 4;
function normalizeComparisonModels(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const models = value.map((model) => String(model).trim()).filter(Boolean).slice(0, MAX_COMPARISON_MODELS);
  return models.length > 0 ? models : undefined;
}

function resolveDispatcher(request: NextRequest, record: Record<string, unknown>): PacketDispatcherAttribution {
  const principal = resolveRequestPrincipal(request);
  const workerPacketId = request.headers.get('x-o8-worker-packet-id')?.trim() ?? '';
  if (principal === 'worker') {
    return { surface: 'agent', id: workerPacketId || 'unknown-worker' };
  }

  const threadId = typeof record.orchestratorThreadId === 'string' ? record.orchestratorThreadId.trim() : '';
  if (threadId) return { surface: 'orchestrator', id: threadId };

  const declared = asRecord(record.dispatcher);
  const declaredSurface = declared?.surface;
  const declaredId = typeof declared?.id === 'string' ? declared.id.trim() : '';
  if (declaredSurface === 'orchestrator' && declaredId) {
    return { surface: 'orchestrator', id: declaredId };
  }
  return { surface: 'operator', id: declaredSurface === 'operator' && declaredId ? declaredId : 'desktop' };
}

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const body = await parseJsonBody(request);
  const record = asRecord(body);
  if (!record) {
    return operatorError('invalid_request', 'Invalid JSON body.', 400);
  }

  const repoPath = typeof record.repoPath === 'string' ? record.repoPath.trim() : '';
  if (!repoPath) {
    return operatorError('invalid_request', 'repoPath is required.', 400);
  }

  const issues = normalizeIssues(record.issues);
  if (!issues) {
    return operatorError('invalid_request', 'issues must be a non-empty array.', 400);
  }

  // When runtime is omitted, preserve the effective operator default as
  // requested routing metadata.
  const requestedRuntimeRaw = record.requestedRuntime ?? record.runtime;
  const requestedModel = record.requestedModel ?? record.model;
  const requestedEffortRaw = record.requestedEffort ?? record.thinkingEffort;
  const requestedEffort = isThinkingEffort(requestedEffortRaw)
    ? requestedEffortRaw
    : null;
  const explicitRuntimeRequested = !(requestedRuntimeRaw === undefined || requestedRuntimeRaw === null || requestedRuntimeRaw === '');
  const requestedRuntime = !explicitRuntimeRequested
    ? resolveDefaultDispatchRuntimeSync()
    : normalizeRuntime(requestedRuntimeRaw);
  if (!requestedRuntime) {
    return operatorError('invalid_request', 'runtime must be one of: "codex", "claude-code", "gemini", "antigravity", "opencode", "cursor", "grok", "pi".', 400);
  }
  if (explicitRuntimeRequested) {
    const dispatchError = runtimeDispatchError(requestedRuntime);
    if (dispatchError) return dispatchError;
  }
  const defaults = getOperatorDefaultsSync().values;
  const profileRouting = resolveSubscriptionProfileRouting({
    profile: defaults.subscriptionProfile,
    requestedRuntime: explicitRuntimeRequested || defaults.subscriptionProfile === 'both' ? requestedRuntime : null,
    requestedModel: typeof requestedModel === 'string' ? requestedModel : null,
    defaultDispatchModel: defaults.defaultDispatchModel,
  });
  if (!profileRouting.ok) {
    return operatorError(profileRouting.code, profileRouting.message, 400);
  }
  for (const issue of issues) {
    if (!issue.runtime) continue;
    const dispatchError = runtimeDispatchError(issue.runtime);
    if (dispatchError) return dispatchError;
    const issueProfileRouting = resolveSubscriptionProfileRouting({
      profile: defaults.subscriptionProfile,
      requestedRuntime: issue.runtime,
      requestedModel: typeof requestedModel === 'string' ? requestedModel : null,
      defaultDispatchModel: defaults.defaultDispatchModel,
    });
    if (!issueProfileRouting.ok) {
      return operatorError(issueProfileRouting.code, issueProfileRouting.message, 400);
    }
  }
  const workerRouting = resolveWorkerRouting({
    workerIntent: record.workerIntent,
    requestedProvider: record.requestedProvider,
    requestedRuntime: profileRouting.requestedRuntime,
    requestedModel: profileRouting.requestedModel,
    requestedEffort,
    source: 'create-mission-api',
  });
  const huddle = typeof record.huddle === 'boolean'
    ? record.huddle
    : isSingleSubCheapTierWorker({
        profile: defaults.subscriptionProfile,
        runtime: workerRouting.selectedRuntime,
        model: workerRouting.selectedModel,
      });
  try {
    await assertRuntimeDispatchable(workerRouting.selectedRuntime);
    for (const issue of issues) {
      if (issue.runtime) await assertRuntimeDispatchable(issue.runtime);
    }
  } catch (error) {
    if (error instanceof DispatchPreflightError) {
      return operatorError(error.code, `${error.status.detail} ${error.status.fix}`, 400, {
        runtime: error.status.runtime,
        house: error.status.house,
        installed: error.status.installed,
        authenticated: error.status.authenticated,
        unavailableReason: error.status.unavailableReason,
      });
    }
    const message = error instanceof Error ? error.message : 'Runtime readiness check failed.';
    return operatorError('runtime_preflight_failed', message, 500);
  }
  const existingBranchPolicy = normalizeExistingBranchPolicy(record.existingBranchPolicy);
  if (record.existingBranchPolicy !== undefined && !existingBranchPolicy) {
    return operatorError('invalid_request', 'existingBranchPolicy must be one of: "auto", "reset", "continue", "error".', 400);
  }

  try {
    const result = await createMission({
      issues,
      repoPath,
      runtime: workerRouting.selectedRuntime,
      workerIntent: workerRouting.workerIntent,
      requestedProvider: workerRouting.requestedProvider,
      requestedRuntime: profileRouting.requestedRuntime,
      requestedModel: workerRouting.requestedModel,
      requestedEffort,
      constraints: typeof record.constraints === 'string' ? record.constraints : '',
      sequential: record.sequential === true,
      existingBranchPolicy,
      ...(typeof record.useBrain === 'boolean' ? { useBrain: record.useBrain } : {}),
      ...(huddle ? { huddle } : {}),
      // #1329 — carry the dispatching orchestrator thread id so workers inherit
      // its session rules. Optional; thread-less callers omit it.
      ...(typeof record.orchestratorThreadId === 'string' && record.orchestratorThreadId.trim()
        ? { orchestratorThreadId: record.orchestratorThreadId.trim() }
        : {}),
      dispatcher: resolveDispatcher(request, record),
      ...(normalizeComparisonModels(record.comparisonModels)
        ? { comparisonModels: normalizeComparisonModels(record.comparisonModels) }
        : {}),
    });
    return operatorSuccess(result, 201);
  } catch (error) {
    if (error instanceof ControlPlaneLockTimeoutError) {
      return operatorError(
        'mission_store_busy',
        'Mission store is busy dispatching — retry in a moment.',
        503,
      );
    }
    const message = error instanceof Error ? error.message : 'Unable to create mission.';
    return operatorError('create_mission_failed', message, 500, error);
  }
}
