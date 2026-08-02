import { describe, expect, it } from 'vitest';

import {
  CONTRACT_COVERAGE_EVIDENCE_SCHEMA,
  parseContractCoverageEvidenceInput,
} from './review-coverage-input';

describe('review coverage input', () => {
  it('keeps the strict-mode schema a plain object and parses review evidence', () => {
    expect(CONTRACT_COVERAGE_EVIDENCE_SCHEMA.type).toBe('object');
    expect(CONTRACT_COVERAGE_EVIDENCE_SCHEMA.required).toEqual(['contractVersion', 'headSha', 'entries']);
    expect(parseContractCoverageEvidenceInput({
      contractVersion: 1,
      headSha: 'a'.repeat(40),
      entries: [{ requirementId: 'R1', productionPath: 'src/example.ts' }],
    })).toMatchObject({
      contractVersion: 1,
      entries: [{ requirementId: 'R1', productionPath: 'src/example.ts' }],
    });
  });

  it('rejects malformed evidence and leaves legacy reviews undefined', () => {
    expect(parseContractCoverageEvidenceInput(undefined)).toBeUndefined();
    expect(() => parseContractCoverageEvidenceInput({ contractVersion: 1 })).toThrow(
      'contractCoverageEvidence must include contractVersion, headSha, and requirement entries',
    );
  });
});
