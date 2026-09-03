import type { OrchestratorRuntime } from '@/lib/orchestrator/types';

export type ExecutionCarrierId = 'ori';

export interface ExecutionCarrierDefinition {
  id: ExecutionCarrierId;
  label: string;
  binaryName: string;
  binaryEnvOverride: string;
  runtimeSubcommands: Readonly<Partial<Record<OrchestratorRuntime, readonly string[]>>>;
}

const EXECUTION_CARRIERS: Readonly<Record<ExecutionCarrierId, ExecutionCarrierDefinition>> = {
  ori: {
    id: 'ori',
    label: 'Ori',
    binaryName: 'ori',
    binaryEnvOverride: 'O8_ORI_BIN',
    runtimeSubcommands: { codex: ['codex'] },
  },
};

export const EXECUTION_CARRIER_RUNTIME_CONFIG_KEY = 'executionCarrier';

export class UnsupportedExecutionCarrierRuntimeError extends Error {
  constructor(carrier: ExecutionCarrierId, runtime: OrchestratorRuntime) {
    super(`Execution carrier '${carrier}' does not support runtime '${runtime}'.`);
    this.name = 'UnsupportedExecutionCarrierRuntimeError';
  }
}

export class UnknownExecutionCarrierError extends Error {
  constructor(value: unknown) {
    super(`Unknown execution carrier ${JSON.stringify(value)}; refusing to fall back to direct runtime credentials.`);
    this.name = 'UnknownExecutionCarrierError';
  }
}

export function isExecutionCarrierId(value: unknown): value is ExecutionCarrierId {
  return value === 'ori';
}

export function executionCarrierDefinition(id: ExecutionCarrierId): ExecutionCarrierDefinition {
  return EXECUTION_CARRIERS[id];
}

export function assertExecutionCarrierCompatible(
  carrier: ExecutionCarrierId,
  runtime: OrchestratorRuntime,
): readonly string[] {
  const subcommand = executionCarrierDefinition(carrier).runtimeSubcommands[runtime];
  if (!subcommand) throw new UnsupportedExecutionCarrierRuntimeError(carrier, runtime);
  return subcommand;
}

export function composeExecutionCarrierInvocation(input: {
  carrier: ExecutionCarrierId | null | undefined;
  runtime: OrchestratorRuntime;
  runtimeBinary: string;
  runtimeArgs: readonly string[];
  carrierBinary?: string;
}): { command: string; args: string[] } {
  if (!input.carrier) {
    return { command: input.runtimeBinary, args: [...input.runtimeArgs] };
  }
  const subcommand = assertExecutionCarrierCompatible(input.carrier, input.runtime);
  if (!input.carrierBinary) throw new Error(`Resolved binary is required for execution carrier '${input.carrier}'.`);
  return { command: input.carrierBinary, args: [...subcommand, ...input.runtimeArgs] };
}

export function executionCarrierRuntimeConfig(
  carrier: ExecutionCarrierId | null | undefined,
): Record<string, string> {
  return carrier ? { [EXECUTION_CARRIER_RUNTIME_CONFIG_KEY]: carrier } : {};
}

export function executionCarrierFromRuntimeConfig(
  runtimeConfig: Record<string, string> | undefined,
): ExecutionCarrierId | null {
  const value = runtimeConfig?.[EXECUTION_CARRIER_RUNTIME_CONFIG_KEY];
  if (value === undefined) return null;
  if (isExecutionCarrierId(value)) return value;
  throw new UnknownExecutionCarrierError(value);
}

export function executionCarrierRuntimeLabel(
  runtimeLabel: string,
  runtimeConfig: Record<string, string> | undefined,
): string {
  const carrier = executionCarrierFromRuntimeConfig(runtimeConfig);
  return carrier ? `${runtimeLabel} via ${executionCarrierDefinition(carrier).label}` : runtimeLabel;
}
