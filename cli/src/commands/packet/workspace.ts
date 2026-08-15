import { randomUUID } from 'node:crypto';

import { CliError, EXIT, SLOW_MUTATION_TIMEOUT_MS } from '../../api.js';
import { resolveConfig } from '../../config.js';
import { printHumanHeading, printHumanKv, printJson, type OutputMode } from '../../output.js';
import { fetchCorrelatedPacketMutation } from './correlated-mutation.js';
import { parsePacketArguments, requirePacketId, resolvePacketTarget } from './target.js';

type WorkspaceAction = 'park' | 'restore';

interface WorkspaceControlResponse {
  ok: boolean;
  result?: {
    action?: WorkspaceAction;
    status?: string;
    clientMutationId?: string;
    packetId?: string;
    laneId?: string;
    repositoryUuid?: string;
    state?: string;
    branch?: string;
    reviewedHead?: string | null;
    reviewFingerprint?: string | null;
    reviewable?: boolean;
    note?: string;
    retryable?: boolean;
    outcomeUnknown?: boolean;
    inProgress?: boolean;
  };
  error?: { message?: string } | string;
}

function responseError(response: WorkspaceControlResponse | null, action: WorkspaceAction): string {
  if (typeof response?.error === 'string') return response.error;
  if (response?.error?.message) return response.error.message;
  return `Workspace ${action} was refused.`;
}

export async function runPacketWorkspace(
  mode: OutputMode,
  action: WorkspaceAction,
  rest: string[],
): Promise<number> {
  const args = parsePacketArguments(rest, {
    command: action,
    valueFlags: ['idempotency-key'],
  });
  const packetId = requirePacketId(await resolvePacketTarget(args.target), action);
  const clientMutationId = args.values['idempotency-key']?.trim() || randomUUID();
  const response = await fetchCorrelatedPacketMutation<WorkspaceControlResponse>(
    resolveConfig(),
    '/api/orchestrator/workspace',
    { action, packetId, clientMutationId },
    { timeoutMs: SLOW_MUTATION_TIMEOUT_MS, allowConflict: true },
  );
  if (!response.data?.ok || !response.data.result) {
    const unknown = response.data?.result?.outcomeUnknown === true;
    throw new CliError(
      unknown ? 'workspace_outcome_unknown' : `workspace_${action}_refused`,
      responseError(response.data, action),
      EXIT.CONFLICT,
      unknown
        ? `Inspect o8 packet info before taking another action. The quarantined mutation id is ${clientMutationId}.`
        : undefined,
      unknown,
    );
  }

  const receipt = response.data.result;
  const payload = {
    schema: `o8/cli/packet.${action}/v1`,
    packet: {
      id: packetId,
      laneId: receipt.laneId ?? null,
      repositoryUuid: receipt.repositoryUuid ?? null,
      branch: receipt.branch ?? null,
      reviewedHead: receipt.reviewedHead ?? null,
    },
    workspace: {
      state: receipt.state ?? null,
      status: receipt.status ?? null,
      reviewable: receipt.reviewable === true,
    },
    clientMutationId,
    note: receipt.note ?? `Workspace ${action} completed.`,
  };
  if (mode.human) {
    printHumanHeading(`packet ${action}`);
    printHumanKv([
      ['packet', packetId],
      ['workspace', receipt.state ?? receipt.status ?? 'unknown'],
      ['branch', receipt.branch ?? '(unknown)'],
      ['review', receipt.reviewable ? 'available' : 'unavailable'],
      ['mutation', clientMutationId],
      ['note', receipt.note ?? `Workspace ${action} completed.`],
    ]);
  } else {
    printJson(payload);
  }
  return 0;
}
