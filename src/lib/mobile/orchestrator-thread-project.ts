import { getProject } from '@/lib/projects/store';

export type OrchestratorThreadProjectErrorCode =
  | 'orchestrator_thread_project_invalid'
  | 'orchestrator_thread_project_not_found'
  | 'orchestrator_thread_project_mismatch';

export class OrchestratorThreadProjectError extends Error {
  readonly code: OrchestratorThreadProjectErrorCode;
  readonly projectId: string | null;
  readonly existingProjectId?: string;

  constructor(input: {
    code: OrchestratorThreadProjectErrorCode;
    message: string;
    projectId: string | null;
    existingProjectId?: string;
  }) {
    super(input.message);
    this.name = 'OrchestratorThreadProjectError';
    this.code = input.code;
    this.projectId = input.projectId;
    this.existingProjectId = input.existingProjectId;
  }

  toPayload() {
    return {
      code: this.code,
      message: this.message,
      projectId: this.projectId,
      ...(this.existingProjectId ? { existingProjectId: this.existingProjectId } : {}),
    };
  }
}

function validateRequestedProjectId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value.trim()) {
    throw new OrchestratorThreadProjectError({
      code: 'orchestrator_thread_project_invalid',
      message: 'projectId must be a non-empty string when provided.',
      projectId: null,
    });
  }
  const projectId = value.trim();
  if (!getProject(projectId)) {
    throw new OrchestratorThreadProjectError({
      code: 'orchestrator_thread_project_not_found',
      message: `Project ${projectId} does not exist.`,
      projectId,
    });
  }
  return projectId;
}

export function resolveOrchestratorThreadProjectId(
  existingValue: unknown,
  requestedValue: unknown,
): string | null {
  const existingProjectId = typeof existingValue === 'string' && existingValue.trim()
    ? existingValue.trim()
    : null;
  const requestedProjectId = validateRequestedProjectId(requestedValue);
  if (existingProjectId && requestedProjectId && existingProjectId !== requestedProjectId) {
    throw new OrchestratorThreadProjectError({
      code: 'orchestrator_thread_project_mismatch',
      message: `Thread belongs to project ${existingProjectId}, not ${requestedProjectId}.`,
      projectId: requestedProjectId,
      existingProjectId,
    });
  }
  return existingProjectId ?? requestedProjectId;
}
