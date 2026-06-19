import { NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { resolveWorkerRouting } from '@/lib/agents/routing';
import {
  buildInlineIssuesFromPrompt,
  createMission,
  dispatchMission,
} from '@/lib/orchestrator/operator-mission-service';
import { resolveDefaultDispatchRuntimeSync } from '@/lib/operator/defaults';
import type { OrchestratorRuntime } from '@/lib/orchestrator/types';
import { asRecord, operatorError, operatorSuccess, parseJsonBody } from '../_utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_REQUESTED_RUNTIMES = new Set<OrchestratorRuntime>(['codex', 'claude-code', 'gemini', 'opencode']);

function normalizeRuntime(value: unknown): OrchestratorRuntime | null {
  if (typeof value === 'string' && VALID_REQUESTED_RUNTIMES.has(value as OrchestratorRuntime)) {
    return value as OrchestratorRuntime;
  }
  return null;
}

/**
 * Voice / canvas spawn seam — "spawn N agents on <task>" → a gateless worktree
 * mission, created and dispatched in one call so cards bloom on the canvas the
 * instant you ask. The worktree spawn is reversible by construction (a branch
 * that touches nothing), so it carries no approval gate; only the downstream
 * irreversible verbs (merge / push / prod) stay gated.
 *
 * Body: { repoPath, task, count?, runtime?, constraints?, useBrain? }
 */
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

  const task = typeof record.task === 'string' ? record.task.trim() : '';
  if (!task) {
    return operatorError('invalid_request', 'task is required.', 400);
  }

  const requestedRuntimeRaw = record.requestedRuntime ?? record.runtime;
  const requestedModel = record.requestedModel ?? record.model;
  const requestedRuntime = requestedRuntimeRaw === undefined || requestedRuntimeRaw === null || requestedRuntimeRaw === ''
    ? resolveDefaultDispatchRuntimeSync()
    : normalizeRuntime(requestedRuntimeRaw);
  if (!requestedRuntime) {
    return operatorError('invalid_request', 'runtime must be one of: "codex", "claude-code", "gemini", "opencode".', 400);
  }

  const workerRouting = resolveWorkerRouting({
    workerIntent: record.workerIntent,
    requestedProvider: record.requestedProvider,
    requestedRuntime,
    requestedModel,
    source: 'spawn-prompt-api',
  });

  let issues;
  try {
    issues = buildInlineIssuesFromPrompt(task, typeof record.count === 'number' ? record.count : 1);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to build spawn tasks.';
    return operatorError('invalid_request', message, 400);
  }

  try {
    const mission = await createMission({
      issues,
      repoPath,
      runtime: workerRouting.selectedRuntime,
      workerIntent: workerRouting.workerIntent,
      requestedProvider: workerRouting.requestedProvider,
      requestedRuntime,
      requestedModel: workerRouting.requestedModel,
      constraints: typeof record.constraints === 'string' ? record.constraints : '',
      ...(typeof record.useBrain === 'boolean' ? { useBrain: record.useBrain } : {}),
    });

    const dispatch = await dispatchMission({ missionId: mission.missionId });

    return operatorSuccess({ ...mission, ...dispatch }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to spawn agents.';
    return operatorError('spawn_prompt_failed', message, 500, error);
  }
}
