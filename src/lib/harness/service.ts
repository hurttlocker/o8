import 'server-only';

import { buildSessionBoot } from './boot';
import { exportHarnessBundle, importHarnessBundle } from './bundle';
import { getHarnessCapabilities } from './capabilities';
import { evaluateDiff } from './evaluator';
import { groundTask } from './ground';
import {
  getComponent,
  listComponents,
  listMeasurements,
  recordMeasurement,
  transitionComponent,
} from './lift-store';
import {
  addFeature,
  canonicalRepoPath,
  getContract,
  getFeature,
  getSprint,
  listContracts,
  listFeatureChecks,
  listFeatures,
  listSprints,
  nextFeature,
  proposeContract,
  recordFeatureCheck,
  setFeatureStatus,
  startSprint,
  tickSprint,
  transitionContract,
} from './store';
import type {
  HarnessCheckStatus,
  HarnessComponentLifecycle,
  HarnessContractStatus,
  HarnessFeatureStatus,
} from './types';

export interface HarnessServiceContext {
  actor: 'operator' | 'worker';
  packetId: string | null;
  repoPath: string | null;
}

function stringValue(body: Record<string, unknown>, key: string, required = false): string {
  const value = body[key];
  if (typeof value === 'string') {
    const clean = value.trim();
    if (clean || !required) return clean;
  }
  if (required) throw new Error(`${key} is required`);
  return '';
}

function optionalString(body: Record<string, unknown>, key: string): string | null {
  const value = stringValue(body, key);
  return value || null;
}

function numberValue(body: Record<string, unknown>, key: string, required = false): number | null {
  const value = body[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (required) throw new Error(`${key} must be a number`);
  return null;
}

function stringArray(body: Record<string, unknown>, key: string): string[] {
  const value = body[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${key} must be an array of strings`);
  }
  return value.map((entry) => entry.trim()).filter(Boolean);
}

function objectValue(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = body[key];
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${key} must be an object`);
  return value as Record<string, unknown>;
}

function repoPath(body: Record<string, unknown>, context: HarnessServiceContext): string {
  const requested = context.repoPath ?? stringValue(body, 'repoPath', true);
  return canonicalRepoPath(requested);
}

function featureStatus(value: string): HarnessFeatureStatus {
  if (value === 'failing' || value === 'passing' || value === 'blocked') return value;
  throw new Error('status must be failing, passing, or blocked');
}

function checkStatus(value: string): HarnessCheckStatus {
  if (value === 'passed' || value === 'failed' || value === 'skipped') return value;
  throw new Error('status must be passed, failed, or skipped');
}

function contractTransition(value: string): Extract<HarnessContractStatus, 'accepted' | 'verified' | 'failed' | 'superseded'> {
  if (value === 'accepted' || value === 'verified' || value === 'failed' || value === 'superseded') return value;
  throw new Error('status must be accepted, verified, failed, or superseded');
}

function componentLifecycle(value: string): HarnessComponentLifecycle {
  if (value === 'retained' || value === 'candidate' || value === 'shadow_only' || value === 'retired') return value;
  throw new Error('lifecycle must be retained, candidate, shadow_only, or retired');
}

function commandValue(body: Record<string, unknown>, key: string): string[] | null {
  const values = stringArray(body, key);
  return values.length ? values : null;
}

function ensureFeatureInRepo(featureId: string, expectedRepo: string): void {
  const feature = getFeature(featureId);
  if (!feature) throw new Error(`feature not found: ${featureId}`);
  if (feature.repoPath !== expectedRepo) throw new Error('feature belongs to a different repository');
}

function ensureContractInRepo(contractId: string, expectedRepo: string): void {
  const contract = getContract(contractId);
  if (!contract) throw new Error(`contract not found: ${contractId}`);
  if (contract.repoPath !== expectedRepo) throw new Error('contract belongs to a different repository');
}

function ensureSprintInRepo(sprintId: string, expectedRepo: string): void {
  const sprint = getSprint(sprintId);
  if (!sprint) throw new Error(`sprint not found: ${sprintId}`);
  if (sprint.repoPath !== expectedRepo) throw new Error('sprint belongs to a different repository');
}

export async function handleHarnessAction(
  body: Record<string, unknown>,
  context: HarnessServiceContext,
): Promise<unknown> {
  const action = stringValue(body, 'action', true);

  if (action === 'capabilities') {
    return getHarnessCapabilities(optionalString(body, 'modelId'));
  }

  const canonical = repoPath(body, context);
  if (action === 'feature_list') {
    const status = optionalString(body, 'status');
    return {
      schema: 'o8/feature-list/v1',
      repoPath: canonical,
      features: listFeatures({
        repoPath: canonical,
        status: status ? featureStatus(status) : null,
        limit: numberValue(body, 'limit') ?? 200,
      }),
    };
  }
  if (action === 'feature_next') {
    return { schema: 'o8/feature-next/v1', repoPath: canonical, feature: nextFeature(canonical) };
  }
  if (action === 'feature_add') {
    return addFeature({
      repoPath: canonical,
      title: stringValue(body, 'title', true),
      description: stringValue(body, 'description'),
      priority: numberValue(body, 'priority') ?? undefined,
      verificationCommand: commandValue(body, 'verificationCommand'),
      metadata: objectValue(body, 'metadata'),
    });
  }
  if (action === 'feature_status') {
    const status = featureStatus(stringValue(body, 'status', true));
    if (status === 'passing') throw new Error('passing status requires a successful verification result');
    return setFeatureStatus({
      featureId: stringValue(body, 'featureId', true),
      status,
      repoPath: canonical,
    });
  }
  if (action === 'feature_checks') {
    const featureId = stringValue(body, 'featureId', true);
    ensureFeatureInRepo(featureId, canonical);
    return { schema: 'o8/feature-checks/v1', checks: listFeatureChecks(featureId, numberValue(body, 'limit') ?? 100) };
  }
  if (action === 'feature_verify') {
    return recordFeatureCheck({
      featureId: stringValue(body, 'featureId', true),
      status: checkStatus(stringValue(body, 'status', true)),
      evidence: stringValue(body, 'evidence'),
      command: commandValue(body, 'command'),
      exitCode: numberValue(body, 'exitCode'),
      modelId: optionalString(body, 'modelId'),
      packetId: context.packetId ?? optionalString(body, 'packetId'),
      repoPath: canonical,
    });
  }
  if (action === 'ground') {
    return groundTask({
      repoPath: canonical,
      task: stringValue(body, 'task', true),
      featureId: optionalString(body, 'featureId'),
      packetId: context.packetId ?? optionalString(body, 'packetId'),
      acceptanceCriteria: stringArray(body, 'acceptanceCriteria'),
    });
  }
  if (action === 'boot') {
    return buildSessionBoot({
      repoPath: canonical,
      task: optionalString(body, 'task'),
      featureId: optionalString(body, 'featureId'),
      packetId: context.packetId ?? optionalString(body, 'packetId'),
      acceptanceCriteria: stringArray(body, 'acceptanceCriteria'),
      modelId: optionalString(body, 'modelId'),
    });
  }
  if (action === 'contract_list') {
    return { schema: 'o8/contract-list/v1', contracts: listContracts(canonical, numberValue(body, 'limit') ?? 50) };
  }
  if (action === 'contract_propose') {
    return proposeContract({
      repoPath: canonical,
      featureId: optionalString(body, 'featureId'),
      groundingId: optionalString(body, 'groundingId'),
      generatorTerms: stringValue(body, 'generatorTerms', true),
      evaluatorTerms: stringValue(body, 'evaluatorTerms', true),
      acceptanceCriteria: stringArray(body, 'acceptanceCriteria'),
      proposedBy: context.actor === 'worker' ? context.packetId : optionalString(body, 'proposedBy') ?? 'operator',
    });
  }
  if (action === 'contract_transition') {
    const contractId = stringValue(body, 'contractId', true);
    ensureContractInRepo(contractId, canonical);
    return transitionContract({
      contractId,
      status: contractTransition(stringValue(body, 'status', true)),
      actor: context.actor === 'worker' ? context.packetId : optionalString(body, 'actor') ?? 'operator',
    });
  }
  if (action === 'sprint_list') {
    return { schema: 'o8/sprint-list/v1', sprints: listSprints(canonical, numberValue(body, 'limit') ?? 50) };
  }
  if (action === 'sprint_start') {
    const contractId = stringValue(body, 'contractId', true);
    ensureContractInRepo(contractId, canonical);
    return startSprint(contractId, context.packetId ?? optionalString(body, 'packetId'));
  }
  if (action === 'sprint_tick') {
    const sprintId = stringValue(body, 'sprintId', true);
    ensureSprintInRepo(sprintId, canonical);
    return tickSprint({ sprintId, note: stringValue(body, 'note') });
  }
  if (action === 'verify') {
    const results = body.results;
    if (!Array.isArray(results) || results.length === 0 || results.length > 50) {
      throw new Error('results must contain between 1 and 50 verification results');
    }
    const sprintId = optionalString(body, 'sprintId');
    if (sprintId) ensureSprintInRepo(sprintId, canonical);
    const normalizedResults = results.map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('each verification result must be an object');
      const row = entry as Record<string, unknown>;
      const featureId = stringValue(row, 'featureId', true);
      ensureFeatureInRepo(featureId, canonical);
      return {
        featureId,
        status: checkStatus(stringValue(row, 'status', true)),
        evidence: stringValue(row, 'evidence'),
        command: commandValue(row, 'command'),
        exitCode: numberValue(row, 'exitCode'),
        modelId: optionalString(row, 'modelId'),
        packetId: context.packetId ?? optionalString(row, 'packetId'),
        repoPath: canonical,
      };
    });
    const checks = normalizedResults.map((result) => recordFeatureCheck(result));
    const sprint = sprintId
      ? tickSprint({ sprintId, note: stringValue(body, 'note') })
      : null;
    return { schema: 'o8/verify/v1', checks, sprint };
  }
  if (action === 'harness_status') {
    const componentKey = optionalString(body, 'componentKey');
    const modelId = optionalString(body, 'modelId');
    return {
      schema: 'o8/harness-status/v1',
      components: componentKey && modelId ? [getComponent(componentKey, modelId)] : listComponents(),
      measurements: listMeasurements({ componentKey, modelId, limit: numberValue(body, 'limit') ?? 200 }),
    };
  }
  if (action === 'harness_measure') {
    return recordMeasurement({
      componentKey: stringValue(body, 'componentKey', true),
      modelId: stringValue(body, 'modelId', true),
      baselineScore: numberValue(body, 'baselineScore', true)!,
      enabledScore: numberValue(body, 'enabledScore', true)!,
      sampleCount: numberValue(body, 'sampleCount', true)!,
      evidence: objectValue(body, 'evidence'),
    });
  }
  if (action === 'harness_transition') {
    return transitionComponent({
      componentKey: stringValue(body, 'componentKey', true),
      modelId: stringValue(body, 'modelId', true),
      lifecycle: componentLifecycle(stringValue(body, 'lifecycle', true)),
      reason: stringValue(body, 'reason', true),
    });
  }
  if (action === 'evaluate_diff') {
    return evaluateDiff({
      repoPath: canonical,
      task: stringValue(body, 'task', true),
      diff: stringValue(body, 'diff', true),
      acceptanceCriteria: stringArray(body, 'acceptanceCriteria'),
    });
  }
  if (action === 'bundle_export') {
    return exportHarnessBundle(canonical);
  }
  if (action === 'bundle_import') {
    return importHarnessBundle({ repoPath: canonical, bundle: body.bundle });
  }
  throw new Error(`unknown harness action: ${action}`);
}
