import { createHash } from 'node:crypto';

// Original o8 implementation. Design provenance and excluded upstream behavior:
// docs/research/harness-improvement.md. Inputs are evidence, never instructions.
export function canonicalJson(value) {
  return JSON.stringify(value, function (_key, entry) {
    return entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, entry[key]])) : entry;
  });
}
export function digest(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
export function object(value, fields, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name}: expected object`);
  const actual = Object.keys(value);
  if (actual.length !== fields.length || actual.some((key) => !fields.includes(key))) {
    throw new Error(`${name}: missing or unknown fields`);
  }
  return value;
}
export function text(value, name, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > max) {
    throw new Error(`${name}: expected bounded nonempty string`);
  }
  return value;
}
export function id(value, name) {
  text(value, name);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)) throw new Error(`${name}: invalid identifier`);
  return value;
}
export function list(value, name, max = 100, min = 1) {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error(`${name}: invalid array size`);
  return value;
}
export function unique(values, name) {
  if (new Set(values).size !== values.length) throw new Error(`${name}: duplicate identity`);
  return values;
}
export function number(value, name, max = 1_000_000) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) throw new Error(`${name}: invalid nonnegative number`);
  return value;
}
function hash(value, name, length = 64) {
  if (typeof value !== 'string' || !new RegExp(`^[a-f0-9]{${length}}$`).test(value)) throw new Error(`${name}: invalid digest`);
}
const IDENTITIES = ['baselineRevision', 'modelId', 'runtimeId', 'verifierDigest', 'permissionsDigest'];
export function validateAdmission(bundle, manifest, proposals, expectedDigest) {
  object(manifest, ['schema', 'experimentId', 'repository', 'contractId', ...IDENTITIES, 'contractDigest', 'budget', 'discoveryTasks', 'heldOutTasks', 'components'], 'manifest');
  if (manifest.schema !== 'o8/harness-improvement-manifest/v1') throw new Error('unsupported manifest schema');
  hash(expectedDigest, 'manifest-sha256');
  if (digest(manifest) !== expectedDigest) throw new Error('frozen manifest digest mismatch');
  id(manifest.experimentId, 'experimentId');
  text(manifest.repository, 'repository', 4_000);
  text(manifest.contractId, 'contractId');
  text(manifest.modelId, 'modelId');
  text(manifest.runtimeId, 'runtimeId');
  hash(manifest.baselineRevision, 'baselineRevision', 40);
  for (const key of ['verifierDigest', 'permissionsDigest', 'contractDigest']) hash(manifest[key], key);
  object(manifest.budget, ['maxUsd', 'maxAttempts'], 'budget');
  number(manifest.budget.maxUsd, 'maxUsd');
  number(manifest.budget.maxAttempts, 'maxAttempts', 1_000);
  if (!Number.isInteger(manifest.budget.maxAttempts) || manifest.budget.maxAttempts < 1) throw new Error('maxAttempts must be a positive integer');
  for (const key of ['discoveryTasks', 'heldOutTasks', 'components']) {
    unique(list(manifest[key], key).map((entry) => id(entry, key)), key);
  }
  if (manifest.discoveryTasks.some((task) => manifest.heldOutTasks.includes(task))) throw new Error('discovery and held-out tasks overlap');
  if (!bundle || bundle.schema !== 'o8/harness-bundle/v1' || bundle.sourceRepoPath !== manifest.repository) throw new Error('bundle repository/schema mismatch');
  for (const key of ['features', 'groundings', 'components', 'measurements', 'contracts']) list(bundle[key], `bundle.${key}`, 2_000, 0);
  const contracts = bundle.contracts.filter((entry) => entry?.id === manifest.contractId);
  if (contracts.length !== 1) throw new Error('contract must resolve uniquely');
  const contract = contracts[0];
  if (!['accepted', 'verified'].includes(contract.status) || typeof contract.acceptedBy !== 'string' || !contract.acceptedBy.trim() || !Number.isFinite(contract.acceptedAt) || contract.acceptedAt < 0) throw new Error('contract is not accepted');
  text(contract.generatorTerms, 'generatorTerms', 50_000);
  text(contract.evaluatorTerms, 'evaluatorTerms', 50_000);
  list(contract.acceptanceCriteria, 'acceptanceCriteria').forEach((entry) => text(entry, 'criterion', 4_000));
  const terms = { generatorTerms: contract.generatorTerms, evaluatorTerms: contract.evaluatorTerms, acceptanceCriteria: contract.acceptanceCriteria };
  if (digest(terms) !== manifest.contractDigest) throw new Error('frozen contract terms mismatch');
  list(proposals, 'proposals', 20);
  unique(proposals.map((proposal) => {
    object(proposal, ['id', ...IDENTITIES, 'changes', 'evidenceRefs'], 'proposal');
    id(proposal.id, 'proposal.id');
    if (proposal.id === 'baseline') throw new Error('baseline is a reserved identity');
    for (const key of IDENTITIES) if (proposal[key] !== manifest[key]) throw new Error(`proposal ${key} mismatch`);
    unique(list(proposal.changes, 'changes', 20).map((change) => {
      object(change, ['componentKey', 'kind', 'text'], 'change');
      if (change.kind !== 'context_note' || !manifest.components.includes(change.componentKey)) throw new Error('change outside allowed context-note surface');
      text(change.text, 'change.text', 8_000);
      return change.componentKey;
    }), 'changed components');
    unique(list(proposal.evidenceRefs, 'evidenceRefs').map((ref) => {
      if (!manifest.discoveryTasks.includes(ref)) throw new Error('proposal evidence must be discovery-only');
      return ref;
    }), 'evidenceRefs');
    return proposal.id;
  }), 'proposals');
  return {
    schema: 'o8/harness-improvement-admission/v1',
    manifestDigest: expectedDigest,
    bundleDigest: digest(bundle),
    experimentId: manifest.experimentId,
    authority: 'advisory_only',
    decision: 'KEEP_BASE',
    reason: 'Proposal admission only; no paired evidence has been evaluated.',
    liveBenefitProven: false,
    proposals: proposals.map((proposal) => ({ id: proposal.id, digest: digest(proposal), components: proposal.changes.map((change) => change.componentKey) })),
    ignoredBundleMeasurements: true,
  };
}
