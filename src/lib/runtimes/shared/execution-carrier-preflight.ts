import type { OrchestratorRuntime } from '@/lib/orchestrator/types';
import { spawn } from 'node:child_process';
import { CliNotFoundError, resolveCli, type ResolvedCli } from './cli-resolver';
import { cliInvocation } from './cli-spawn';
import {
  assertExecutionCarrierCompatible,
  executionCarrierDefinition,
  type ExecutionCarrierId,
} from './execution-carrier';

export type ExecutionCarrierPreflightFailure =
  | 'unsupported-pair'
  | 'missing-carrier'
  | 'missing-runtime'
  | 'unsafe-carrier-binary'
  | 'carrier-auth-unavailable';

export class ExecutionCarrierPreflightError extends Error {
  constructor(
    public readonly failure: ExecutionCarrierPreflightFailure,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ExecutionCarrierPreflightError';
  }
}

type ResolveCli = typeof resolveCli;

const RUNTIME_CLI: Partial<Record<OrchestratorRuntime, {
  binaryName: string;
  envOverride: string;
}>> = {
  codex: { binaryName: 'codex', envOverride: 'O8_CODEX_BIN' },
};

export interface ExecutionCarrierPreflightEvidence {
  runtime: OrchestratorRuntime;
  runtimeBinaryName: string;
  runtimeCli: ResolvedCli;
  executionCarrier: ExecutionCarrierId;
  carrierBinaryName: string;
  carrierCli: ResolvedCli;
  authSource: 'execution-carrier';
  authenticated: true;
}

export async function probeExecutionCarrierAuth(binary: string): Promise<boolean> {
  const invocation = cliInvocation(binary, ['auth']);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const child = spawn(invocation.command, invocation.args, {
      windowsHide: true,
      stdio: 'ignore',
      env: process.env,
    });
    const timeout = setTimeout(() => { child.kill(); finish(false); }, 10_000);
    child.once('error', () => finish(false));
    child.once('exit', (code) => finish(code === 0));
  });
}

export async function assertExecutionCarrierDispatchable(
  runtime: OrchestratorRuntime,
  carrier: ExecutionCarrierId,
  resolve: ResolveCli = resolveCli,
  probeAuth: (binary: string) => Promise<boolean> = probeExecutionCarrierAuth,
): Promise<ExecutionCarrierPreflightEvidence> {
  try {
    assertExecutionCarrierCompatible(carrier, runtime);
  } catch (error) {
    throw new ExecutionCarrierPreflightError(
      'unsupported-pair',
      `Execution carrier '${carrier}' cannot dispatch the '${runtime}' runtime.`,
      error,
    );
  }

  const runtimeSpec = RUNTIME_CLI[runtime];
  if (!runtimeSpec) {
    throw new ExecutionCarrierPreflightError(
      'missing-runtime',
      `The '${runtime}' runtime does not expose an underlying CLI contract for execution carriers.`,
    );
  }

  let carrierCli: ResolvedCli;
  const definition = executionCarrierDefinition(carrier);
  try {
    carrierCli = await resolve({
      runtimeId: `execution-carrier:${carrier}`,
      binaryName: definition.binaryName,
      envOverride: definition.binaryEnvOverride,
    });
  } catch (error) {
    if (!(error instanceof CliNotFoundError)) throw error;
    throw new ExecutionCarrierPreflightError(
      'missing-carrier',
      `Execution carrier '${carrier}' is selected, but '${definition.binaryName}' was not found. Install it or set ${definition.binaryEnvOverride}.`,
      error,
    );
  }

  if (process.platform === 'win32' && !/\.(?:exe|com)$/i.test(carrierCli.path)) {
    throw new ExecutionCarrierPreflightError(
      'unsafe-carrier-binary',
      `Execution carrier '${carrier}' resolved to a script wrapper. On Windows, ${definition.binaryEnvOverride} must name a native .exe or .com binary so worker argv never passes through cmd.exe.`,
    );
  }

  if (!await probeAuth(carrierCli.path)) {
    throw new ExecutionCarrierPreflightError(
      'carrier-auth-unavailable',
      `Execution carrier '${carrier}' could not resolve credentials. Run '${definition.binaryName} login'; if '${definition.binaryName} auth' is unknown, upgrade Ori to 0.3.0 or newer.`,
    );
  }

  let runtimeCli: ResolvedCli;
  try {
    runtimeCli = await resolve({ runtimeId: runtime, ...runtimeSpec });
  } catch (error) {
    if (!(error instanceof CliNotFoundError)) throw error;
    throw new ExecutionCarrierPreflightError(
      'missing-runtime',
      `Execution carrier '${carrier}' is available, but the underlying '${runtimeSpec.binaryName}' CLI was not found. Install it or set ${runtimeSpec.envOverride}.`,
      error,
    );
  }

  return {
    runtime,
    runtimeBinaryName: runtimeSpec.binaryName,
    runtimeCli,
    executionCarrier: carrier,
    carrierBinaryName: definition.binaryName,
    carrierCli,
    authSource: 'execution-carrier',
    authenticated: true,
  };
}
