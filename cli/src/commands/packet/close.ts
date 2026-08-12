import { randomUUID } from 'node:crypto';
import { CliError, EXIT, SLOW_MUTATION_TIMEOUT_MS } from '../../api.js';
import { resolveConfig } from '../../config.js';
import {
  printHumanHeading,
  printHumanKv,
  printJson,
  type OutputMode,
} from '../../output.js';
import {
  parsePacketArguments,
  requirePacketId,
  resolvePacketTarget,
} from './target.js';
import { fetchCorrelatedPacketMutation } from './correlated-mutation.js';

const DISPOSITIONS = ['adopted_elsewhere', 'superseded', 'spec_changed', 'wontfix'] as const;
type Disposition = typeof DISPOSITIONS[number];

interface CloseResponse {
  ok: boolean;
  result?: {
    closed?: boolean;
    disposition?: Disposition;
    note?: string;
    inProgress?: boolean;
    status?: string;
    laneId?: string;
    worktreeRemoved?: boolean;
    preservedBranch?: string | null;
  };
  error?: { message?: string } | string;
}

function errorMessage(response: CloseResponse | null | undefined): string {
  if (typeof response?.error === 'string') return response.error;
  if (response?.error?.message) return response.error.message;
  return 'Packet close was rejected.';
}

export async function runPacketClose(mode: OutputMode, rest: string[]): Promise<number> {
  const args = parsePacketArguments(rest, { command: 'close', valueFlags: ['reason', 'note', 'idempotency-key'] });
  const reason = args.values.reason?.trim();
  if (!reason || !(DISPOSITIONS as readonly string[]).includes(reason)) {
    throw new CliError(
      'invalid_args',
      'o8 packet close requires --reason adopted_elsewhere|superseded|spec_changed|wontfix.',
      EXIT.INVALID_ARGS,
      'Example: o8 packet close --reason adopted_elsewhere --note "Implemented in o8-mobile."',
    );
  }

  const packetId = requirePacketId(await resolvePacketTarget(args.target), 'close');
  const cfg = resolveConfig();
  const res = await fetchCorrelatedPacketMutation<CloseResponse>(
    cfg,
    '/api/orchestrator/discard-packet',
    {
      packetId,
      disposition: reason,
      note: args.values.note?.trim() || undefined,
      clientMutationId: args.values['idempotency-key']?.trim() || randomUUID(),
    },
    { timeoutMs: SLOW_MUTATION_TIMEOUT_MS },
  );
  if (!res.data?.ok || !res.data.result?.closed) {
    throw new CliError('close_failed', errorMessage(res.data), EXIT.CONFLICT);
  }

  const result = res.data.result;
  const payload = {
    schema: 'o8/cli/packet.close/v1',
    packet: {
      id: packetId,
      disposition: result.disposition ?? reason,
      laneId: result.laneId ?? null,
      preservedBranch: result.preservedBranch ?? null,
      worktreeRemoved: result.worktreeRemoved === true,
    },
    note: result.note ?? 'Closed unmerged.',
  };
  if (mode.human) {
    printHumanHeading('packet close');
    printHumanKv([
      ['packet', packetId],
      ['disposition', result.disposition ?? reason],
      ['branch', result.preservedBranch ?? '(none)'],
      ['worktree', result.worktreeRemoved ? 'removed' : 'preserved or already absent'],
      ['note', result.note ?? 'Closed unmerged.'],
    ]);
  } else {
    printJson(payload);
  }
  return 0;
}
