import { describe, expect, it, vi } from 'vitest';

import { CliNotFoundError, type CliResolverSpec, type ResolvedCli } from './cli-resolver';
import {
  composeExecutionCarrierInvocation,
  executionCarrierFromRuntimeConfig,
  executionCarrierRuntimeConfig,
  UnknownExecutionCarrierError,
  UnsupportedExecutionCarrierRuntimeError,
} from './execution-carrier';
import {
  executionCarrierCommandIdentity,
  executionCarrierSandboxReadPaths,
  executionCarrierSpawnPath,
  resolveExecutionCarrierInvocation,
} from './execution-carrier-launch';
import { assertExecutionCarrierDispatchable, ExecutionCarrierPreflightError } from './execution-carrier-preflight';

function resolved(path: string): ResolvedCli {
  return { path, source: 'env', detectedAt: 1, envHint: 'test' };
}

const carrierBinary = process.platform === 'win32' ? 'C:\\tools\\ori.exe' : '/tools/ori';

describe('typed execution carriers', () => {
  it('composes Ori and Codex as structured argv without a shell string', () => {
    expect(composeExecutionCarrierInvocation({
      carrier: 'ori', runtime: 'codex', carrierBinary: '/bin/ori',
      runtimeBinary: '/bin/codex', runtimeArgs: ['exec', '--json', 'hello; echo unsafe'],
    })).toEqual({ command: '/bin/ori', args: ['codex', 'exec', '--json', 'hello; echo unsafe'] });
  });

  it('keeps the no-carrier invocation unchanged', async () => {
    const resolve = vi.fn();
    await expect(resolveExecutionCarrierInvocation({
      runtime: 'codex', runtimeConfig: undefined, runtimeBinary: '/bin/codex',
      runtimeArgs: ['exec', '--json'], resolve,
    })).resolves.toEqual({ command: '/bin/codex', args: ['exec', '--json'], carried: false });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('exposes an off-PATH underlying runtime to the carrier and keeps Ori state read-only', async () => {
    const runtimeBinary = process.platform === 'win32' ? 'C:\\private\\codex.exe' : '/private/codex';
    const launch = await resolveExecutionCarrierInvocation({
      runtime: 'codex', runtimeConfig: { executionCarrier: 'ori' }, runtimeBinary,
      runtimeArgs: ['exec', '--json'], resolve: async () => resolved(carrierBinary),
    });
    expect(launch).toMatchObject({ command: carrierBinary, args: ['codex', 'exec', '--json'], carried: true });
    expect(executionCarrierSpawnPath('base-path', launch).split(process.platform === 'win32' ? ';' : ':')[0])
      .toBe(process.platform === 'win32' ? 'C:\\private' : '/private');
    expect(executionCarrierSandboxReadPaths(['/mcp'], launch)).toEqual(expect.arrayContaining([
      '/mcp', expect.stringMatching(/[\\/]\.ori$/), process.platform === 'win32' ? 'C:\\private' : '/private',
    ]));
    expect(executionCarrierCommandIdentity(launch, '/usr/bin/sandbox-exec')).toBe(carrierBinary);
  });

  it('rejects unsupported carrier/runtime pairs', () => {
    expect(() => composeExecutionCarrierInvocation({
      carrier: 'ori', runtime: 'claude-code', carrierBinary: '/bin/ori',
      runtimeBinary: '/bin/claude', runtimeArgs: ['--print'],
    })).toThrow(UnsupportedExecutionCarrierRuntimeError);
  });

  it('round-trips the credential-free runtime config pin', () => {
    expect(executionCarrierRuntimeConfig('ori')).toEqual({ executionCarrier: 'ori' });
    expect(executionCarrierFromRuntimeConfig({ executionCarrier: 'ori' })).toBe('ori');
    expect(executionCarrierRuntimeConfig(null)).toEqual({});
    expect(() => executionCarrierFromRuntimeConfig({ executionCarrier: 'future-carrier' }))
      .toThrow(UnknownExecutionCarrierError);
  });

  it('reports a missing carrier separately from a missing underlying runtime', async () => {
    const missingCarrier = vi.fn(async (spec: CliResolverSpec) => {
      throw new CliNotFoundError(spec.binaryName, []);
    });
    await expect(assertExecutionCarrierDispatchable('codex', 'ori', missingCarrier, async () => true))
      .rejects.toMatchObject({ failure: 'missing-carrier' } satisfies Partial<ExecutionCarrierPreflightError>);

    const missingRuntime = vi.fn(async (spec: CliResolverSpec) => {
      if (spec.runtimeId === 'execution-carrier:ori') return resolved(carrierBinary);
      throw new CliNotFoundError(spec.binaryName, []);
    });
    await expect(assertExecutionCarrierDispatchable('codex', 'ori', missingRuntime, async () => true))
      .rejects.toMatchObject({ failure: 'missing-runtime' } satisfies Partial<ExecutionCarrierPreflightError>);
  });

  it('fails closed when the carrier cannot resolve credentials', async () => {
    const resolve = vi.fn(async (spec: CliResolverSpec) => resolved(
      spec.runtimeId === 'execution-carrier:ori' ? carrierBinary : `/bin/${spec.binaryName}`,
    ));
    await expect(assertExecutionCarrierDispatchable('codex', 'ori', resolve, async () => false))
      .rejects.toMatchObject({ failure: 'carrier-auth-unavailable' } satisfies Partial<ExecutionCarrierPreflightError>);
  });

  it('reports carrier auth evidence without credentials', async () => {
    const resolve = vi.fn(async (spec: CliResolverSpec) => resolved(
      spec.runtimeId === 'execution-carrier:ori' ? carrierBinary : `/bin/${spec.binaryName}`,
    ));
    const evidence = await assertExecutionCarrierDispatchable('codex', 'ori', resolve, async () => true);
    expect(evidence).toMatchObject({ runtime: 'codex', executionCarrier: 'ori', authSource: 'execution-carrier', authenticated: true });
    expect(JSON.stringify(evidence)).not.toMatch(/token|secret|credential/i);
  });

  it.skipIf(process.platform !== 'win32')('rejects Windows script carriers before prompt argv can reach cmd.exe', async () => {
    const resolve = vi.fn(async (spec: CliResolverSpec) => resolved(
      spec.runtimeId === 'execution-carrier:ori' ? 'C:\\tools\\ori.cmd' : 'C:\\tools\\codex.exe',
    ));
    await expect(assertExecutionCarrierDispatchable('codex', 'ori', resolve, async () => true))
      .rejects.toMatchObject({ failure: 'unsafe-carrier-binary' });
  });
});
