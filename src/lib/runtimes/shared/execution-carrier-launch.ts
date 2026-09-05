import type { OrchestratorRuntime } from '@/lib/orchestrator/types';
import os from 'node:os';
import path from 'node:path';
import { resolveCli, type CliResolverSpec } from './cli-resolver';
import {
  composeExecutionCarrierInvocation,
  executionCarrierDefinition,
  executionCarrierFromRuntimeConfig,
} from './execution-carrier';

type ResolveCli = (spec: CliResolverSpec) => ReturnType<typeof resolveCli>;

export interface ExecutionCarrierInvocation {
  command: string;
  args: string[];
  carried: boolean;
  runtimeBinDir?: string;
}

export async function resolveExecutionCarrierInvocation(input: {
  runtime: OrchestratorRuntime;
  runtimeConfig: Record<string, string> | undefined;
  runtimeBinary: string;
  runtimeArgs: readonly string[];
  resolve?: ResolveCli;
}): Promise<ExecutionCarrierInvocation> {
  const carrier = executionCarrierFromRuntimeConfig(input.runtimeConfig);
  if (!carrier) {
    const invocation = composeExecutionCarrierInvocation({
      carrier: null,
      runtime: input.runtime,
      runtimeBinary: input.runtimeBinary,
      runtimeArgs: input.runtimeArgs,
    });
    return { ...invocation, carried: false };
  }

  const definition = executionCarrierDefinition(carrier);
  const carrierCli = await (input.resolve ?? resolveCli)({
    runtimeId: `execution-carrier:${carrier}`,
    binaryName: definition.binaryName,
    envOverride: definition.binaryEnvOverride,
  });
  if (process.platform === 'win32' && !/\.(?:exe|com)$/i.test(carrierCli.path)) {
    throw new Error(
      `Execution carrier '${carrier}' resolved to a script wrapper; Windows carrier launches require a native .exe or .com binary.`,
    );
  }
  const invocation = composeExecutionCarrierInvocation({
    carrier,
    runtime: input.runtime,
    runtimeBinary: input.runtimeBinary,
    runtimeArgs: input.runtimeArgs,
    carrierBinary: carrierCli.path,
  });
  return {
    ...invocation,
    carried: true,
    ...(path.isAbsolute(input.runtimeBinary) ? { runtimeBinDir: path.dirname(input.runtimeBinary) } : {}),
  };
}

export function executionCarrierSpawnPath(
  basePath: string,
  launch: ExecutionCarrierInvocation,
): string {
  return launch.runtimeBinDir ? `${launch.runtimeBinDir}${path.delimiter}${basePath}` : basePath;
}

export function executionCarrierSandboxReadPaths(
  basePaths: readonly string[],
  launch: ExecutionCarrierInvocation,
): string[] {
  return launch.carried
    ? [...basePaths, path.join(os.homedir(), '.ori'), ...(launch.runtimeBinDir ? [launch.runtimeBinDir] : [])]
    : [...basePaths];
}

export function executionCarrierCommandIdentity(
  launch: ExecutionCarrierInvocation,
  spawnBinary: string,
): string {
  return launch.carried ? launch.command : path.basename(spawnBinary);
}
