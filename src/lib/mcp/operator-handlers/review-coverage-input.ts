import { readCoverageEvidence, type ReviewCoverageEvidence } from '@/lib/orchestrator/task-contract-coverage';

export const CONTRACT_COVERAGE_EVIDENCE_SCHEMA = {
  type: 'object',
  description: 'Required for contract-armed packets: evidence for every sealed requirement, bound to the reviewed HEAD and contract version.',
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
