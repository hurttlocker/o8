import { randomUUID } from 'node:crypto';

import { CliError, EXIT, SLOW_MUTATION_TIMEOUT_MS } from '../../api.js';
import { resolveConfig } from '../../config.js';
import { printHumanHeading, printHumanKv, printJson, type OutputMode } from '../../output.js';
import { fetchCorrelatedPacketMutation } from './correlated-mutation.js';
import { parsePacketArguments, requirePacketId, resolvePacketTarget } from './target.js';

interface ArtifactRecoveryResponse {
  ok: boolean;
  result?: {
    sourcePacketId: string;
    targetPacketId: string;
    restoreId: string;
    restoredFiles: number;
    restoredBytes: number;
    holdId: string;
  };
  error?: { message?: string } | string;
}

export async function runPacketArtifactRecovery(mode: OutputMode, rest: string[]): Promise<number> {
  const args = parsePacketArguments(rest, {
    command: 'restore-artifacts', valueFlags: ['to', 'paths-json', 'idempotency-key'],
  });
  let paths: unknown;
  try { paths = JSON.parse(args.values['paths-json'] ?? 'null'); } catch { paths = null; }
  if (!args.values.to?.trim() || !Array.isArray(paths) || !paths.length
    || paths.some((entry) => typeof entry !== 'string')) {
    throw new CliError('invalid_args', 'packet restore-artifacts requires --to <successor> and --paths-json <relative path array>.', EXIT.INVALID_ARGS);
  }
  const sourcePacketId = requirePacketId(await resolvePacketTarget(args.target), 'restore-artifacts');
  const targetPacketId = requirePacketId(await resolvePacketTarget(args.values.to), 'restore-artifacts');
  const clientMutationId = args.values['idempotency-key']?.trim() || randomUUID();
  const response = await fetchCorrelatedPacketMutation<ArtifactRecoveryResponse>(
    resolveConfig(), '/api/orchestrator/workspace/preservation',
    { sourcePacketId, targetPacketId, paths, clientMutationId },
    { timeoutMs: SLOW_MUTATION_TIMEOUT_MS, allowConflict: true },
  );
  if (!response.data?.ok || !response.data.result) {
    const error = response.data?.error;
    throw new CliError('artifact_recovery_refused', typeof error === 'string'
      ? error : error?.message || 'Workspace artifact recovery was refused.', EXIT.CONFLICT);
  }
  const result = response.data.result;
  if (mode.human) {
    printHumanHeading('packet restore-artifacts');
    printHumanKv([
      ['source', result.sourcePacketId], ['successor', result.targetPacketId],
      ['restored files', String(result.restoredFiles)], ['restored bytes', String(result.restoredBytes)],
      ['hold', result.holdId],
    ]);
  } else printJson({ schema: 'o8/cli/packet.artifact-recovery/v1', clientMutationId, ...result });
  return 0;
}
