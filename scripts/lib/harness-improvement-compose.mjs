import { digest, id, list, number, object, unique } from './harness-improvement.mjs';

// Original deterministic scaffolding, not a model-driven composer. No evidence input.
export function composeSuccessor(admission, manifest, proposals, request) {
  object(request, ['schema', 'parentIds', 'maxChanges', 'maxTextBytes'], 'composition request');
  if (request.schema !== 'o8/harness-composition-request/v1') throw new Error('unsupported composition schema');
  const parentIds = unique(list(request.parentIds, 'parentIds', 20, 2).map((value) => id(value, 'parentId')), 'parentIds').slice().sort();
  for (const [key, max] of [['maxChanges', 20], ['maxTextBytes', 160_000]]) {
    number(request[key], key, max);
    if (!Number.isInteger(request[key]) || request[key] < 1) throw new Error(`${key}: expected positive integer`);
  }
  const parents = parentIds.map((parentId) => {
    const parent = proposals.find((proposal) => proposal.id === parentId);
    if (!parent) throw new Error('unknown composition parent');
    return parent;
  });
  const changes = parents.flatMap((parent) => parent.changes).map((change) => ({ ...change }))
    .sort((a, b) => a.componentKey < b.componentKey ? -1 : a.componentKey > b.componentKey ? 1 : 0);
  unique(changes.map((change) => change.componentKey), 'conflicting component edits');
  const textBytes = changes.reduce((sum, change) => sum + Buffer.byteLength(change.text, 'utf8'), 0);
  if (changes.length > request.maxChanges || textBytes > request.maxTextBytes) throw new Error('composition artifact bound exceeded');
  const evidenceRefs = [...new Set(parents.flatMap((parent) => parent.evidenceRefs))].sort();
  const lineage = parents.map((parent) => ({ id: parent.id, digest: digest(parent) }));
  const identity = { manifestDigest: admission.manifestDigest, lineage, changes, evidenceRefs };
  const candidateId = `composed-${digest(identity)}`;
  if (proposals.some((proposal) => proposal.id === candidateId)) throw new Error('composition identity collision');
  const bindings = Object.fromEntries(['baselineRevision', 'modelId', 'runtimeId', 'verifierDigest', 'permissionsDigest'].map((key) => [key, manifest[key]]));
  const proposal = { id: candidateId, ...bindings, changes, evidenceRefs };
  return {
    schema: 'o8/harness-composition-report/v1', manifestDigest: admission.manifestDigest,
    bundleDigest: admission.bundleDigest, experimentId: manifest.experimentId,
    authority: 'advisory_only', decision: 'KEEP_BASE', status: 'untested', verificationRequired: true,
    reason: 'New combined candidate requires its own complete paired receipts; parent evidence and approval do not transfer.',
    receiptsAuthenticated: false, liveBenefitProven: false,
    lineage, limits: { maxChanges: request.maxChanges, maxTextBytes: request.maxTextBytes },
    textBytes, proposal, proposalDigest: digest(proposal),
  };
}
