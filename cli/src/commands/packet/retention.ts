import { randomUUID } from 'node:crypto';

import { CliError, EXIT, SLOW_MUTATION_TIMEOUT_MS } from '../../api.js';
import { resolveConfig } from '../../config.js';
import { printHumanHeading, printHumanKv, printJson, type OutputMode } from '../../output.js';
import { fetchCorrelatedPacketMutation } from './correlated-mutation.js';
import { parsePacketArguments, requirePacketId, resolvePacketTarget } from './target.js';

interface RetentionResponse {
  ok: boolean;
  result?: {
    hold?: { holdId: string; held: boolean; reason: string; version: number };
    note?: string;
  };
  error?: { message?: string } | string;
}

export async function runPacketRetention(
  mode: OutputMode,
  action: 'hold' | 'release',
  rest: string[],
): Promise<number> {
  const command = action === 'hold' ? 'retain' : 'release-retention';
  const args = parsePacketArguments(rest, {
    command,
    valueFlags: ['reason', 'hold-id', 'idempotency-key'],
  });
  const reason = args.values.reason?.trim() ?? '';
  const holdId = args.values['hold-id']?.trim() ?? '';
  if (action === 'hold' && !reason) {
    throw new CliError('invalid_args', 'packet retain requires --reason.', EXIT.INVALID_ARGS);
  }
  if (action === 'release' && !holdId) {
    throw new CliError('invalid_args', 'packet release-retention requires --hold-id.', EXIT.INVALID_ARGS);
  }
  const packetId = requirePacketId(await resolvePacketTarget(args.target), command);
  const clientMutationId = args.values['idempotency-key']?.trim() || randomUUID();
  const response = await fetchCorrelatedPacketMutation<RetentionResponse>(
    resolveConfig(),
    '/api/orchestrator/workspace/retention',
    { action, packetId, clientMutationId, ...(action === 'hold' ? { reason } : { holdId }) },
    { timeoutMs: SLOW_MUTATION_TIMEOUT_MS, allowConflict: true },
  );
  if (!response.data?.ok || !response.data.result?.hold) {
    const error = response.data?.error;
    throw new CliError(
      'workspace_retention_refused',
      typeof error === 'string' ? error : error?.message || 'Workspace retention was refused.',
      EXIT.CONFLICT,
    );
  }
  const result = response.data.result;
  if (mode.human) {
    printHumanHeading('packet ' + command);
    printHumanKv([
      ['packet', packetId],
      ['held', result.hold!.held ? 'yes' : 'no'],
      ['hold', result.hold!.holdId],
      ['reason', result.hold!.reason],
    ]);
  } else {
    printJson({ schema: 'o8/cli/packet.retention/v1', packetId, clientMutationId, ...result });
  }
  return 0;
}
