import { validateRuntimeModelSelection } from '@/lib/runtimes/shared/model-compatibility';
import { assertExecutionCarrierCompatible } from '@/lib/runtimes/shared/execution-carrier';
import { parseOperatorDefaultsToml } from '@/lib/settings/toml';
import type { OperatorDefaults } from './defaults';
import { isSubscriptionProfile, resolveSubscriptionProfileHouseDefaults } from './subscription-profile';
import { isDispatchRuntime } from './defaults-env';

type RoutingCompatibilityValues = Pick<
  OperatorDefaults,
  'subscriptionProfile' | 'defaultDispatchRuntime' | 'workerExecutionCarrier'
    | 'defaultDispatchModel' | 'targetingTriage' | 'targetingAction'
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
  assertExecutionCarrierRoutingCompatibility(values);
  assertRuntimeModelCompatibility(values.targetingTriage.runtime, values.targetingTriage.model, 'Triage');
  assertRuntimeModelCompatibility(values.targetingAction.runtime, values.targetingAction.model, 'Action tier');
}

export function assertExecutionCarrierRoutingCompatibility(values: RoutingCompatibilityValues): void {
  const effectiveRuntime = resolveSubscriptionProfileHouseDefaults(values.subscriptionProfile)?.defaultDispatchRuntime
    ?? values.defaultDispatchRuntime;
  if (values.workerExecutionCarrier) {
    try {
      assertExecutionCarrierCompatible(values.workerExecutionCarrier, effectiveRuntime);
    } catch {
      throw new Error(
        `Execution carrier '${values.workerExecutionCarrier}' is incompatible with the effective default runtime '${effectiveRuntime}'. Select a compatible runtime or use Direct.`,
      );
    }
  }
}

export function assertRoutingTomlCompatibility(
  raw: string,
  fallback: OperatorDefaults,
): void {
  const values = { ...fallback, ...parseOperatorDefaultsToml(raw) };
  if (isSubscriptionProfile(process.env.O8_SUBSCRIPTION_PROFILE)) {
    values.subscriptionProfile = process.env.O8_SUBSCRIPTION_PROFILE;
  }
  if (isDispatchRuntime(process.env.O8_DEFAULT_DISPATCH_RUNTIME)) {
    values.defaultDispatchRuntime = process.env.O8_DEFAULT_DISPATCH_RUNTIME;
  }
  assertRoutingCompatibility(values);
}

export function routingUpdateTouchesCompatibility(update: Partial<OperatorDefaults>): boolean {
  return update.subscriptionProfile !== undefined
    || update.defaultDispatchRuntime !== undefined
    || update.workerExecutionCarrier !== undefined
    || update.defaultDispatchModel !== undefined
    || update.targetingTriage !== undefined
    || update.targetingAction !== undefined;
}
