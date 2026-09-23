import { readCoverageEvidence, type ReviewCoverageEvidence } from '@/lib/orchestrator/task-contract-coverage';

export const CONTRACT_COVERAGE_EVIDENCE_SCHEMA = {
  type: 'object',
  description: 'Required for contract-armed packets: changed-file evidence for each file requirement and separate process observations, bound to the reviewed HEAD and contract version.',
  properties: {
    contractVersion: { type: 'number' },
    headSha: { type: 'string' },
    entries: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          requirementId: { type: 'string' },
          productionPath: { type: 'string', description: 'Repo-relative file path touched by the change.' },
          anchor: { type: 'string' },
          verification: { type: 'string' },
        },
        required: ['requirementId', 'productionPath'],
      },
    },
    processEntries: {
      type: 'array',
      description: 'One reviewer observation per process constraint; omit only when the contract has no process constraints.',
      items: {
        type: 'object',
        properties: {
          constraintId: { type: 'string' },
          source: { type: 'string', enum: ['transcript', 'lane-event', 'command'] },
          reference: { type: 'string', description: 'Concrete turn, event, or command observation; do not cite a changed file as proof of an unrelated process action.' },
        },
        required: ['constraintId', 'source', 'reference'],
      },
    },
  },
  required: ['contractVersion', 'headSha', 'entries'],
} as const;

export function parseContractCoverageEvidenceInput(value: unknown): ReviewCoverageEvidence | undefined {
  if (value === undefined) return undefined;
  const evidence = readCoverageEvidence({ contractCoverageEvidence: value });
  if (!evidence) {
    throw new Error('contractCoverageEvidence must include contractVersion, headSha, and requirement entries');
  }
  return evidence;
}
