import type { OrchestratorRuntime } from '@/lib/orchestrator/types';
import type { CreateMissionInput } from '@/lib/orchestrator/operator-mission-service/types';

export function assertQualitySearchMissionCompatibility(
  input: Pick<CreateMissionInput, 'issues' | 'qualitySearch' | 'comparisonModels' | 'huddle' | 'taskContract'>,
): void {
  if (!input.qualitySearch) return;
  if (input.issues.length !== 1) {
    throw new Error('Quality search requires exactly one task per mission.');
  }
  if (input.comparisonModels?.length) {
    throw new Error('Quality search cannot be combined with a separate comparison fan-out.');
  }
  if (input.huddle) {
    throw new Error('Quality search already uses a sealed contract and cannot be combined with huddle mode.');
  }
  if (input.taskContract === 'off') {
    throw new Error('Quality search already uses a sealed contract and cannot be combined with taskContract: "off".');
  }
}

export function resolveTaskContractRequired(input: {
  runtime: OrchestratorRuntime;
  missionOptOut?: boolean;
  explicit?: boolean;
}): boolean {
  if (input.explicit === true) return true;
  if (input.missionOptOut === true) return false;
  return input.runtime === 'claude-code' || input.runtime === 'codex';
}
