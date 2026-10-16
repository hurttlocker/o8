import { CONTROLLED_OPENROUTER_MODEL, parseControlledProvider, type ControlledOpenRouterPolicy } from '@/lib/runtimes/shared/owned-session/controlled-provider';
import { isSupportedModelId } from '@/lib/models';
import { resolveEffortPin, type ConcreteThinkingEffort } from '@/lib/orchestrator/effort-pin';
import { getRuntimeCapability } from '@/lib/orchestrator/runtime-capabilities';
import { parseSealedTaskContract } from '@/lib/orchestrator/sealed-task-contract';
import type { PacketTaskContract } from '@/lib/orchestrator/types';

export class TaskDraftError extends Error {
  constructor(public readonly code: string, public readonly status = 400) {
    super(code);
  }
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TaskDraftError('invalid_arguments');
  return value as Record<string, unknown>;
}

export function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (required.some((key) => !(key in value)) || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) {
    throw new TaskDraftError('invalid_arguments');
  }
}

export function normalizedText(value: unknown, max = 256): string {
  if (typeof value !== 'string' || !value || value.trim() !== value || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) {
    throw new TaskDraftError('invalid_arguments');
  }
  return value;
}

export function relativeFile(value: unknown): string {
  const file = normalizedText(value, 240);
  if (file.startsWith('/') || file.includes('\\') || /[:*?\[\]{}]/.test(file)
    || file.split('/').some((part) => !part || part === '.' || part === '..' || part === '.git' || part === '.env' || part.startsWith('.env.'))) {
    throw new TaskDraftError('invalid_file_scope');
  }
  return file;
}

function list(value: unknown, max: number, parse: (entry: unknown) => string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) throw new TaskDraftError('invalid_arguments');
  const parsed = value.map(parse);
  if (new Set(parsed).size !== parsed.length) throw new TaskDraftError('invalid_arguments');
  return parsed;
}

export interface TaskDraftContract {
  machineId: string;
  repoId: string;
  projectId: string;
  snapshotId: string;
  idempotencyKey: string;
  objective: string;
  allowedFiles: string[];
  runtime: 'codex' | 'claude-code';
  model: string;
  effort: ConcreteThinkingEffort | 'provider-default';
  provider?: ControlledOpenRouterPolicy;
  workMode: 'read-only';
  evidence: string[];
  sealedTaskContract: PacketTaskContract;
}

export function parseTaskDraftContract(input: unknown): TaskDraftContract {
  const value = object(input);
  exactKeys(value, ['machineId', 'repoId', 'projectId', 'snapshotId', 'idempotencyKey', 'objective',
    'allowedFiles', 'runtime', 'model', 'effort', 'workMode', 'evidence', 'sealedTaskContract'], ['provider']);
  if (value.workMode !== 'read-only' || (value.runtime !== 'codex' && value.runtime !== 'claude-code')) {
    throw new TaskDraftError('unsupported_work_mode_or_runtime');
  }
  const runtime = value.runtime;
  const model = normalizedText(value.model);
  let provider: ControlledOpenRouterPolicy | undefined;
  let selectedEffort: TaskDraftContract['effort'];
  if (value.provider !== undefined && value.provider !== null) {
    try { provider = parseControlledProvider(value.provider); }
    catch { throw new TaskDraftError('invalid_arguments'); }
    if (runtime !== 'claude-code' || model !== CONTROLLED_OPENROUTER_MODEL) throw new TaskDraftError('model_incompatible');
    if (value.effort !== 'provider-default') throw new TaskDraftError('effort_not_honored');
    selectedEffort = 'provider-default';
  } else {
    if (!isSupportedModelId(model) || !getRuntimeCapability(runtime).modelIdPattern?.test(model)) {
      throw new TaskDraftError('model_incompatible');
    }
    const effort = resolveEffortPin({ runtime, model, explicitModel: model, requestedEffort: value.effort });
    if (!effort.ok || !effort.selectedEffort || effort.selectedEffort !== value.effort || effort.selectedEffort === 'adaptive') {
      throw new TaskDraftError('effort_not_honored');
    }
    selectedEffort = effort.selectedEffort;
  }
  let sealedTaskContract: PacketTaskContract;
  try { sealedTaskContract = parseSealedTaskContract(value.sealedTaskContract); }
  catch { throw new TaskDraftError('invalid_task_contract'); }
  const allowedFiles = list(value.allowedFiles, 16, relativeFile);
  const mappedFiles = sealedTaskContract.smallestRoute.map((entry) => relativeFile(entry.path));
  if (mappedFiles.some((file) => !allowedFiles.includes(file))
    || allowedFiles.some((file) => !mappedFiles.includes(file))
    || sealedTaskContract.requirements.some((entry) => !allowedFiles.includes(relativeFile(entry.productionPath)))) {
    throw new TaskDraftError('contract_file_scope_mismatch');
  }
  return {
    machineId: normalizedText(value.machineId), repoId: normalizedText(value.repoId),
    projectId: normalizedText(value.projectId), snapshotId: normalizedText(value.snapshotId),
    idempotencyKey: normalizedText(value.idempotencyKey), objective: normalizedText(value.objective, 2000),
    allowedFiles, runtime, model, effort: selectedEffort, ...(provider ? { provider } : {}),
    workMode: 'read-only', evidence: list(value.evidence, 8, (entry) => normalizedText(entry, 480)),
    sealedTaskContract,
  };
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}
