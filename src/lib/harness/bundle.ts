import 'server-only';

import { randomUUID } from 'node:crypto';
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
  getGrounding,
  listContracts,
  listFeatureChecks,
  listFeatures,
  listGroundings,
  proposeContract,
  recordFeatureCheck,
  saveGrounding,
  setFeatureStatus,
  transitionContract,
} from './store';
import {
  HARNESS_BUNDLE_SCHEMA,
  type HarnessBundleV1,
  type HarnessComponentLifecycle,
} from './types';

const MAX_BUNDLE_FEATURES = 500;
const MAX_BUNDLE_GROUNDINGS = 100;
const MAX_BUNDLE_CONTRACTS = 200;
const MAX_BUNDLE_MEASUREMENTS = 2_000;

export function exportHarnessBundle(repoPath: string): HarnessBundleV1 {
  const canonical = canonicalRepoPath(repoPath);
  const features = listFeatures({ repoPath: canonical, limit: MAX_BUNDLE_FEATURES });
  return {
    schema: HARNESS_BUNDLE_SCHEMA,
    exportedAt: Date.now(),
    sourceRepoPath: canonical,
    features: features.map((feature) => ({
      id: feature.id,
      title: feature.title,
      description: feature.description,
      priority: feature.priority,
      status: feature.status,
      verificationCommand: feature.verificationCommand,
      metadata: feature.metadata,
      createdAt: feature.createdAt,
      updatedAt: feature.updatedAt,
      checks: listFeatureChecks(feature.id, 500).reverse(),
    })),
    groundings: listGroundings(canonical, MAX_BUNDLE_GROUNDINGS).reverse(),
    contracts: listContracts(canonical, MAX_BUNDLE_CONTRACTS)
      .reverse()
      .map((contract) => ({
        id: contract.id,
        featureId: contract.featureId,
        groundingId: contract.groundingId,
        generatorTerms: contract.generatorTerms,
        evaluatorTerms: contract.evaluatorTerms,
        acceptanceCriteria: contract.acceptanceCriteria,
        status: contract.status,
        proposedBy: contract.proposedBy,
        acceptedBy: contract.acceptedBy,
        createdAt: contract.createdAt,
        acceptedAt: contract.acceptedAt,
        updatedAt: contract.updatedAt,
      })),
    components: listComponents(),
    measurements: listMeasurements({ limit: MAX_BUNDLE_MEASUREMENTS }).reverse(),
  };
}

function requireBundle(value: unknown): HarnessBundleV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('bundle must be an object');
  const bundle = value as Partial<HarnessBundleV1>;
  if (bundle.schema !== HARNESS_BUNDLE_SCHEMA) throw new Error(`unsupported bundle schema: ${String(bundle.schema)}`);
  if (!Array.isArray(bundle.features) || bundle.features.length > MAX_BUNDLE_FEATURES) {
    throw new Error(`bundle features must contain at most ${MAX_BUNDLE_FEATURES} entries`);
  }
  if (!Array.isArray(bundle.groundings) || bundle.groundings.length > MAX_BUNDLE_GROUNDINGS) {
    throw new Error(`bundle groundings must contain at most ${MAX_BUNDLE_GROUNDINGS} entries`);
  }
  if (!Array.isArray(bundle.contracts) || bundle.contracts.length > MAX_BUNDLE_CONTRACTS) {
    throw new Error(`bundle contracts must contain at most ${MAX_BUNDLE_CONTRACTS} entries`);
  }
  if (!Array.isArray(bundle.components) || bundle.components.length > 1_000) {
    throw new Error('bundle components must contain at most 1000 entries');
  }
  if (!Array.isArray(bundle.measurements) || bundle.measurements.length > MAX_BUNDLE_MEASUREMENTS) {
    throw new Error(`bundle measurements must contain at most ${MAX_BUNDLE_MEASUREMENTS} entries`);
  }
  return bundle as HarnessBundleV1;
}

function sourceKey(sourceRepoPath: string, id: string): string {
  return `${sourceRepoPath}\u0000${id}`;
}

function advanceLifecycle(
  componentKey: string,
  modelId: string,
  target: HarnessComponentLifecycle,
  reason: string,
): void {
  let current = getComponent(componentKey, modelId);
  const path: HarnessComponentLifecycle[] = target === 'retained'
    ? ['retained']
    : target === 'candidate'
      ? ['candidate']
      : target === 'shadow_only'
        ? ['candidate', 'shadow_only']
        : ['candidate', 'shadow_only', 'retired'];
  if (current.lifecycle === target) return;
  if (current.lifecycle !== 'retained') {
    current = transitionComponent({ componentKey, modelId, lifecycle: 'retained', reason });
  }
  for (const lifecycle of path) {
    if (current.lifecycle === lifecycle) continue;
    current = transitionComponent({ componentKey, modelId, lifecycle, reason });
  }
}

export function importHarnessBundle(input: {
  repoPath: string;
  bundle: unknown;
}): {
  schema: 'o8/harness-bundle-import/v1';
  imported: { features: number; checks: number; groundings: number; contracts: number; measurements: number; components: number };
  reusedFeatures: number;
  warnings: string[];
} {
  const targetRepo = canonicalRepoPath(input.repoPath);
  const bundle = requireBundle(input.bundle);
  const warnings: string[] = [];
  const imported = { features: 0, checks: 0, groundings: 0, contracts: 0, measurements: 0, components: 0 };
  let reusedFeatures = 0;
  const featureMap = new Map<string, string>();
  const groundingMap = new Map<string, string>();
  const existingFeatures = listFeatures({ repoPath: targetRepo, limit: MAX_BUNDLE_FEATURES });

  for (const source of bundle.features) {
    const key = sourceKey(bundle.sourceRepoPath, source.id);
    const existing = existingFeatures.find((feature) => (
      feature.metadata.bundleSourceKey === key
      || (targetRepo === bundle.sourceRepoPath && feature.id === source.id)
    ));
    const feature = existing ?? addFeature({
      repoPath: targetRepo,
      title: source.title,
      description: source.description,
      priority: source.priority,
      verificationCommand: source.verificationCommand,
      metadata: { ...source.metadata, bundleSourceKey: key },
    });
    featureMap.set(source.id, feature.id);
    if (existing) {
      reusedFeatures += 1;
      continue;
    }
    imported.features += 1;
    for (const check of source.checks) {
      recordFeatureCheck({
        featureId: feature.id,
        status: check.status,
        evidence: check.evidence,
        command: check.command,
        exitCode: check.exitCode,
        modelId: check.modelId,
        packetId: check.packetId,
        repoPath: targetRepo,
      });
      imported.checks += 1;
    }
    if (source.status !== feature.status) {
      setFeatureStatus({ featureId: feature.id, status: source.status, repoPath: targetRepo });
    }
  }

  const existingGroundings = listGroundings(targetRepo, MAX_BUNDLE_GROUNDINGS);
  for (const source of bundle.groundings) {
    const provenance = `Imported from ${bundle.sourceRepoPath}:${source.id}.`;
    const existing = existingGroundings.find((grounding) => (
      grounding.warnings.includes(provenance)
      || (targetRepo === bundle.sourceRepoPath && grounding.id === source.id)
    ));
    const exact = targetRepo === bundle.sourceRepoPath ? getGrounding(source.id) : null;
    const reused = existing ?? exact;
    if (reused) {
      groundingMap.set(source.id, reused.id);
      continue;
    }
    const id = `grounding-${randomUUID()}`;
    const grounding = saveGrounding({
      ...source,
      id,
      repoPath: targetRepo,
      featureId: source.featureId ? featureMap.get(source.featureId) ?? null : null,
      packetId: null,
      createdAt: Date.now(),
      warnings: [...source.warnings, provenance],
    });
    existingGroundings.push(grounding);
    groundingMap.set(source.id, id);
    imported.groundings += 1;
  }

  for (const source of bundle.contracts) {
    const key = sourceKey(bundle.sourceRepoPath, source.id);
    const existing = listContracts(targetRepo, MAX_BUNDLE_CONTRACTS)
      .find((contract) => (
        contract.proposedBy === `bundle:${key}`
        || (targetRepo === bundle.sourceRepoPath && contract.id === source.id)
      ));
    if (existing) {
      continue;
    }
    const contract = proposeContract({
      repoPath: targetRepo,
      featureId: source.featureId ? featureMap.get(source.featureId) ?? null : null,
      groundingId: source.groundingId ? groundingMap.get(source.groundingId) ?? null : null,
      generatorTerms: source.generatorTerms,
      evaluatorTerms: source.evaluatorTerms,
      acceptanceCriteria: source.acceptanceCriteria,
      proposedBy: `bundle:${key}`,
    });
    if (source.status !== 'proposed') {
      transitionContract({ contractId: contract.id, status: 'accepted', actor: 'bundle-import' });
      if (source.status !== 'accepted') {
        transitionContract({
          contractId: contract.id,
          status: source.status === 'verified' ? 'verified' : source.status === 'failed' ? 'failed' : 'superseded',
          actor: 'bundle-import',
        });
      }
    }
    imported.contracts += 1;
  }

  const existingMeasurements = listMeasurements({ limit: MAX_BUNDLE_MEASUREMENTS });
  const existingMeasurementIds = new Set(existingMeasurements.map((measurement) => measurement.id));
  const existingMeasurementKeys = new Set(
    existingMeasurements.map((measurement) => (
      typeof measurement.evidence.bundleSourceKey === 'string' ? measurement.evidence.bundleSourceKey : ''
    )),
  );
  for (const source of bundle.measurements) {
    const key = sourceKey(bundle.sourceRepoPath, source.id);
    if (
      existingMeasurementKeys.has(key)
      || (targetRepo === bundle.sourceRepoPath && existingMeasurementIds.has(source.id))
    ) continue;
    recordMeasurement({
      componentKey: source.componentKey,
      modelId: source.modelId,
      baselineScore: source.baselineScore,
      enabledScore: source.enabledScore,
      sampleCount: source.sampleCount,
      evidence: { ...source.evidence, bundleSourceKey: key },
    });
    existingMeasurementKeys.add(key);
    imported.measurements += 1;
  }

  for (const source of bundle.components) {
    try {
      advanceLifecycle(
        source.componentKey,
        source.modelId,
        source.lifecycle,
        `Imported from HarnessBundle exported at ${bundle.exportedAt}.`,
      );
      imported.components += 1;
    } catch (error) {
      warnings.push(
        `Component ${source.componentKey}/${source.modelId} stopped before ${source.lifecycle}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    schema: 'o8/harness-bundle-import/v1',
    imported,
    reusedFeatures,
    warnings,
  };
}
