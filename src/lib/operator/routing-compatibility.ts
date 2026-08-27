import { validateRuntimeModelSelection } from '@/lib/runtimes/shared/model-compatibility';
import { parseOperatorDefaultsToml } from '@/lib/settings/toml';
import type { OperatorDefaults } from './defaults';

type RoutingCompatibilityValues = Pick<
  OperatorDefaults,
  'defaultDispatchRuntime' | 'defaultDispatchModel' | 'targetingTriage' | 'targetingAction'
>;

function assertRuntimeModelCompatibility(
  runtime: RoutingCompatibilityValues['defaultDispatchRuntime'],
  model: string,
  label: string,
): void {
  const error = validateRuntimeModelSelection(runtime, model, label);
  if (error) {
    throw new Error(`${error} Open Settings > Models > Runtime routing to choose a supported model or clear the model pin.`);
  }
}

export function assertRoutingCompatibility(values: RoutingCompatibilityValues): void {
  assertRuntimeModelCompatibility(values.defaultDispatchRuntime, values.defaultDispatchModel, 'Default worker');
  assertRuntimeModelCompatibility(values.targetingTriage.runtime, values.targetingTriage.model, 'Triage');
  assertRuntimeModelCompatibility(values.targetingAction.runtime, values.targetingAction.model, 'Action tier');
}

export function assertRoutingTomlCompatibility(
  raw: string,
  fallback: OperatorDefaults,
): void {
  assertRoutingCompatibility({ ...fallback, ...parseOperatorDefaultsToml(raw) });
}

export function routingUpdateTouchesCompatibility(update: Partial<OperatorDefaults>): boolean {
  return update.defaultDispatchRuntime !== undefined
    || update.defaultDispatchModel !== undefined
    || update.targetingTriage !== undefined
    || update.targetingAction !== undefined;
}
