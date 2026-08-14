import { describe, expect, it } from 'vitest';

import { ORCHESTRATOR_RUNTIME_IDS } from '@/lib/orchestrator/runtime-capabilities';
import {
  RUNTIME_EVIDENCE_DEFINITIONS,
  parseGrokModelCatalogue,
  runtimeEvidenceFreshness,
  validateRuntimeEvidenceDefinitions,
  type RuntimeEvidenceDefinition,
} from './runtime-evidence';

describe('runtime evidence catalog', () => {
  it('covers every runtime with valid provenance, transport, billing, and freshness inputs', () => {
    expect(Object.keys(RUNTIME_EVIDENCE_DEFINITIONS)).toEqual(ORCHESTRATOR_RUNTIME_IDS);
    expect(validateRuntimeEvidenceDefinitions(RUNTIME_EVIDENCE_DEFINITIONS)).toEqual([]);
  });

  it('rejects omitted provenance and freshness fields', () => {
    const broken = structuredClone(RUNTIME_EVIDENCE_DEFINITIONS) as Record<string, RuntimeEvidenceDefinition>;
    broken.grok.sources = [];
    broken.codex.carriers = [];
    broken.opencode.sources[0].observedAt = 'not-a-date';
    broken['deepseek-harness'].sources[0].maxAgeDays = 0;

    expect(validateRuntimeEvidenceDefinitions(broken)).toEqual(expect.arrayContaining([
      'grok: provenance is required',
      'codex: carrier evidence is required',
      'opencode/o8-contract-opencode: observedAt must be an ISO date',
      'deepseek-harness/o8-contract-deepseek-harness: maxAgeDays must be positive',
    ]));
  });

  it('keeps broker pricing separate from native runtime defaults', () => {
    expect(RUNTIME_EVIDENCE_DEFINITIONS.opencode.pricing).toEqual(expect.arrayContaining([
      expect.objectContaining({ providerId: 'x-ai', modelId: 'grok-4.6', billingMode: 'api-token' }),
      expect.objectContaining({ providerId: 'deepseek', modelId: 'deepseek-v4-pro-0813', billingMode: 'api-token' }),
      expect.objectContaining({ providerId: 'google', modelId: 'gemini-3.7-flash', billingMode: 'api-token' }),
    ]));
    expect(RUNTIME_EVIDENCE_DEFINITIONS.grok.advertisedModelIds).toContain('grok-4.20-0309-non-reasoning');
    expect(RUNTIME_EVIDENCE_DEFINITIONS.grok.transports).toContain('acp');
    expect(RUNTIME_EVIDENCE_DEFINITIONS.grok.pricing).toEqual([]);
    expect(RUNTIME_EVIDENCE_DEFINITIONS['deepseek-harness'].carriers).toContainEqual(
      expect.objectContaining({ os: 'darwin', architectures: ['x64'], support: 'supported' }),
    );
    expect(RUNTIME_EVIDENCE_DEFINITIONS['deepseek-harness'].transports).toContain('acp');
  });

  it('projects missing, fresh, and stale evidence without guessing', () => {
    expect(runtimeEvidenceFreshness(RUNTIME_EVIDENCE_DEFINITIONS.codex, new Date('2026-08-14T12:00:00Z'))).toBe('missing');
    expect(runtimeEvidenceFreshness(RUNTIME_EVIDENCE_DEFINITIONS.opencode, new Date('2026-08-14T12:00:00Z'))).toBe('fresh');
    expect(runtimeEvidenceFreshness(RUNTIME_EVIDENCE_DEFINITIONS.opencode, new Date('2027-08-14T12:00:00Z'))).toBe('stale');
  });

  it('extracts the live native Grok default and advertised model ids', () => {
    expect(parseGrokModelCatalogue(`
Default model: grok-4.20-0309-non-reasoning

Available models:
  * grok-4.20-0309-non-reasoning (default)
  - grok-4.6
  - grok-build-0.1
`)).toEqual({
      defaultModel: 'grok-4.20-0309-non-reasoning',
      models: ['grok-4.20-0309-non-reasoning', 'grok-4.6', 'grok-build-0.1'],
    });
  });
});
