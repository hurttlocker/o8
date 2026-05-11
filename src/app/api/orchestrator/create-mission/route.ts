import { NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { createMission, type ExistingBranchPolicy, type LoadedIssue } from '@/lib/orchestrator/operator-mission-service';
import { resolveDefaultDispatchRuntimeSync } from '@/lib/operator/defaults';
import type { OrchestratorRuntime } from '@/lib/orchestrator/types';
import { asRecord, operatorError, operatorSuccess, parseJsonBody } from '../_utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// claude-code is intentionally excluded from dispatch runtimes (issue #650).
// The orchestrator (which is itself Claude) can spawn native Claude
// sub-agents inline via the Agent tool when that's the right fit; we don't
// need to wrap claude-code as a dispatched fleet worker.
const VALID_DISPATCH_RUNTIMES = new Set<OrchestratorRuntime>(['codex', 'gemini', 'opencode']);
const VALID_EXISTING_BRANCH_POLICIES = new Set<ExistingBranchPolicy>(['auto', 'reset', 'continue', 'error']);

function normalizeRuntime(value: unknown): OrchestratorRuntime | null {
  if (typeof value === 'string' && VALID_DISPATCH_RUNTIMES.has(value as OrchestratorRuntime)) {
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
    return {
      number: typeof record?.number === 'number' ? record.number : Number.NaN,
      title: typeof record?.title === 'string' ? record.title : '',
      body: typeof record?.body === 'string' ? record.body : '',
      url: typeof record?.url === 'string' ? record.url : '',
    };
  });
}

function normalizeExistingBranchPolicy(value: unknown): ExistingBranchPolicy | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return VALID_EXISTING_BRANCH_POLICIES.has(value as ExistingBranchPolicy)
    ? value as ExistingBranchPolicy
    : undefined;
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

  // When runtime is omitted, fall back to the operator-configured default so
  // callers that don't want to pin a runtime get the user's preferred CLI.
  const runtimeValue = record.runtime === undefined || record.runtime === null || record.runtime === ''
    ? resolveDefaultDispatchRuntimeSync()
    : normalizeRuntime(record.runtime);
  if (!runtimeValue) {
    if (typeof record.runtime === 'string' && record.runtime === 'claude-code') {
      return operatorError(
        'invalid_request',
        'claude-code is no longer dispatchable (#650). Use "codex", "gemini", or "opencode" — or run the work inline via the orchestrator (it is Claude Code under the hood and can spawn native Claude sub-agents).',
        400,
      );
    }
    return operatorError('invalid_request', 'runtime must be one of: "codex", "gemini", "opencode".', 400);
  }
  const existingBranchPolicy = normalizeExistingBranchPolicy(record.existingBranchPolicy);
  if (record.existingBranchPolicy !== undefined && !existingBranchPolicy) {
    return operatorError('invalid_request', 'existingBranchPolicy must be one of: "auto", "reset", "continue", "error".', 400);
  }

  try {
    const result = await createMission({
      issues,
      repoPath,
      runtime: runtimeValue,
      constraints: typeof record.constraints === 'string' ? record.constraints : '',
      sequential: record.sequential === true,
      existingBranchPolicy,
    });
    return operatorSuccess(result, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to create mission.';
    return operatorError('create_mission_failed', message, 500, error);
  }
}
