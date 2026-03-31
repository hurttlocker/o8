import { NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { createMission, type LoadedIssue } from '@/lib/orchestrator/operator-mission-service';
import type { OrchestratorRuntime } from '@/lib/orchestrator/types';
import { asRecord, operatorError, operatorSuccess, parseJsonBody } from '../_utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function normalizeRuntime(value: unknown): OrchestratorRuntime | null {
  if (value === 'codex' || value === 'claude-code') {
    return value;
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

  const runtimeValue = normalizeRuntime(record.runtime);
  if (!runtimeValue) {
    return operatorError('invalid_request', 'runtime must be "codex" or "claude-code".', 400);
  }

  try {
    const result = await createMission({
      issues,
      repoPath,
      runtime: runtimeValue,
      constraints: typeof record.constraints === 'string' ? record.constraints : '',
    });
    return operatorSuccess(result, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to create mission.';
    return operatorError('create_mission_failed', message, 500, error);
  }
}
