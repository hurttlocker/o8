import 'server-only';

import { listComponents } from './lift-store';
import { GROUNDING_FILE_SCAN_LIMIT } from './ground';
import {
  HARNESS_CAPABILITIES_SCHEMA,
  type HarnessCapabilities,
} from './types';

export const EVALUATOR_DIFF_BYTE_LIMIT = 300_000;

export function getHarnessCapabilities(modelId?: string | null): HarnessCapabilities {
  const normalizedModel = modelId?.trim() || null;
  const componentGuidance = listComponents()
    .filter((component) => !normalizedModel || component.modelId === normalizedModel);

  return {
    schema: HARNESS_CAPABILITIES_SCHEMA,
    version: 1,
    artifacts: [
      {
        id: 'feature-ledger',
        description: 'Repo-scoped, machine-readable work and verification state.',
        cli: ['o8 feature list', 'o8 feature next', 'o8 feature add', 'o8 feature verify'],
        mcp: ['o8_feature_list', 'o8_feature_next', 'o8_feature_add', 'o8_feature_verify'],
      },
      {
        id: 'grounding',
        description: 'Persisted impact maps containing real tracked paths and matching symbols.',
        cli: ['o8 ground', 'o8 boot'],
        mcp: ['o8_ground_task', 'o8_session_boot'],
      },
      {
        id: 'execution-loop',
        description: 'Generator/evaluator contracts, one-feature sprints, and computational verification.',
        cli: ['o8 contract', 'o8 sprint', 'o8 verify'],
        mcp: ['o8_negotiate_contract', 'o8_sprint', 'o8_verify'],
      },
      {
        id: 'lift-lifecycle',
        description: 'Paired, model-keyed measurements with operator-controlled component lifecycle changes.',
        cli: ['o8 harness status', 'o8 harness measure', 'o8 harness transition'],
        mcp: ['o8_harness_lift_status', 'o8_harness_measure', 'o8_harness_transition'],
      },
      {
        id: 'skeptic-service',
        description: 'Independent diff evaluation that receives no generator transcript or self-review.',
        cli: ['o8 evaluate-diff'],
        mcp: ['o8_evaluate_diff'],
      },
      {
        id: 'ci-and-portability',
        description: 'Versioned local CI checks plus non-secret HarnessBundle export/import.',
        cli: ['o8 ci', 'o8 harness export', 'o8 harness import'],
        mcp: ['o8_harness_bundle'],
      },
    ],
    recommendedCallOrder: [
      'o8_session_boot',
      'o8_feature_next',
      'o8_ground_task',
      'o8_negotiate_contract',
      'o8_sprint',
      'o8_verify',
      'o8_evaluate_diff',
      'submit_review',
      'approve_and_merge',
    ],
    componentGuidance,
    limits: {
      evaluatorDiffBytes: EVALUATOR_DIFF_BYTE_LIMIT,
      groundingFilesScanned: GROUNDING_FILE_SCAN_LIMIT,
      bundleVersion: 1,
    },
  };
}
