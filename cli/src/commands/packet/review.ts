import { sep } from 'node:path';
import { apiFetch, CliError, EXIT } from '../../api.js';
import { resolveConfig } from '../../config.js';
import {
  printHumanHeading,
  printHumanKv,
  printJson,
  type OutputMode,
} from '../../output.js';

interface Lane {
  id: string;
  label: string;
  status: string;
  branch: string;
  baseBranch: string;
  repoPath: string;
  worktreePath: string | null;
  packetId: string | null;
}

interface WorktreeMatch {
  worktreePath: string;
  packetSlug: string;
}

interface ReviewArgs {
  packetId: string | null;
  approve: boolean;
  expectedHeadSha: string | null;
  commitMessage: string | null;
}

interface OperatorResponse<T> {
  ok: boolean;
  result?: T;
  error?: { message?: string } | string;
}

function detectWorktree(cwd: string): WorktreeMatch | null {
  const parts = cwd.split(sep);
  for (let i = parts.length - 1; i >= 1; i--) {
    const prev = parts[i - 1];
    const cur = parts[i];
    if (!cur || !cur.startsWith('packet-')) continue;
    if (prev === '.cortex-worktrees') {
      return {
        worktreePath: parts.slice(0, i + 1).join(sep),
        packetSlug: cur.slice('packet-'.length),
      };
    }
    if (prev === 'worktrees' && parts[i - 2] === '.claude') {
      return {
        worktreePath: parts.slice(0, i + 1).join(sep),
        packetSlug: cur.slice('packet-'.length),
      };
    }
  }
  return null;
}

function parseReviewArgs(rest: string[]): ReviewArgs {
  let packetId: string | null = null;
  let approve = false;
  let expectedHeadSha: string | null = null;
  let commitMessage: string | null = null;

  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === '--approve') {
      approve = true;
    } else if (tok === '--expected-sha') {
      expectedHeadSha = rest[++i] ?? null;
    } else if (tok.startsWith('--expected-sha=')) {
      expectedHeadSha = tok.slice('--expected-sha='.length);
    } else if (tok === '--commit-message') {
      commitMessage = rest[++i] ?? null;
    } else if (tok.startsWith('--commit-message=')) {
      commitMessage = tok.slice('--commit-message='.length);
    } else if (tok === '--packet') {
      packetId = rest[++i] ?? null;
    } else if (tok.startsWith('--packet=')) {
      packetId = tok.slice('--packet='.length);
    } else if (!tok.startsWith('--') && !packetId) {
      packetId = tok;
    }
  }

  return {
    packetId: packetId?.trim() || null,
    approve,
    expectedHeadSha: expectedHeadSha?.trim() || null,
    commitMessage: commitMessage?.trim() || null,
  };
}

function responseError(payload: OperatorResponse<unknown> | null | undefined, fallback: string) {
  const error = payload?.error;
  if (typeof error === 'string' && error.trim()) return error;
  if (error && typeof error === 'object' && typeof error.message === 'string' && error.message.trim()) {
    return error.message;
  }
  return fallback;
}

function resolveLane(lanes: Lane[], match: WorktreeMatch): Lane | null {
  return lanes.find((lane) => lane.worktreePath === match.worktreePath)
    ?? lanes.find((lane) => lane.packetId && match.packetSlug.includes(lane.packetId))
    ?? lanes.find((lane) => lane.worktreePath && lane.worktreePath.endsWith(`packet-${match.packetSlug}`))
    ?? null;
}

async function resolvePacketId(explicitPacketId: string | null): Promise<string> {
  if (explicitPacketId) {
    return explicitPacketId;
  }

  const match = detectWorktree(process.cwd());
  if (!match) {
    throw new CliError(
      'not_in_packet_worktree',
      'Current directory is not inside an o8 packet worktree.',
      EXIT.NOT_FOUND,
      'Pass a packet id or run from a `.cortex-worktrees/packet-<id>` worktree.',
    );
  }

  const cfg = resolveConfig();
  const lanesRes = await apiFetch<{ lanes: Lane[] }>(cfg, '/api/lanes', { query: { active: 'false' } });
  const lane = resolveLane(lanesRes.data?.lanes ?? [], match);
  if (!lane?.packetId) {
    throw new CliError(
      'lane_not_found',
      `No packet-bound lane registered for worktree ${match.worktreePath}.`,
      EXIT.NOT_FOUND,
      'The lane may have been archived or the registry is out of sync. Run `o8 status` to confirm.',
    );
  }
  return lane.packetId;
}

export async function runPacketReview(mode: OutputMode, rest: string[]): Promise<number> {
  const args = parseReviewArgs(rest);
  if (!args.approve) {
    throw new CliError(
      'invalid_args',
      'o8 packet review currently requires --approve.',
      EXIT.INVALID_ARGS,
      'Example: o8 packet review --approve --expected-sha $(git rev-parse HEAD)',
    );
  }

  const packetId = await resolvePacketId(args.packetId);
  const cfg = resolveConfig();
  const reviewRes = await apiFetch<OperatorResponse<{
    recorded: boolean;
    reviewedHeadSha?: string | null;
  }>>(cfg, '/api/orchestrator/review', {
    method: 'POST',
    body: {
      packetId,
      approved: true,
      findings: [],
      reviewedHeadSha: args.expectedHeadSha ?? undefined,
    },
  });
  if (!reviewRes.data?.ok) {
    throw new CliError('review_failed', responseError(reviewRes.data, 'Packet review was rejected.'), EXIT.CONFLICT);
  }
  const reviewResult = reviewRes.data.result;
  if (!reviewResult) {
    throw new CliError('review_failed', 'Packet review returned no result.', EXIT.CONFLICT);
  }

  const mergeRes = await apiFetch<OperatorResponse<{
    merged: boolean;
    note: string;
    currentHeadSha?: string;
    expectedHeadSha?: string;
  }>>(cfg, '/api/orchestrator/merge', {
    method: 'POST',
    body: {
      packetId,
      commitMessage: args.commitMessage ?? undefined,
      expectedHeadSha: args.expectedHeadSha ?? undefined,
    },
  });
  if (!mergeRes.data?.ok || !mergeRes.data.result) {
    throw new CliError('merge_failed', responseError(mergeRes.data, 'Packet merge was rejected.'), EXIT.CONFLICT);
  }

  const payload = {
    schema: 'o8/cli/packet.review/v1',
    packet: {
      id: packetId,
      approved: true,
      reviewedHeadSha: reviewResult.reviewedHeadSha ?? args.expectedHeadSha,
      merge: mergeRes.data.result,
    },
  };

  if (mode.human) {
    printHumanHeading('packet review');
    printHumanKv([
      ['packet', packetId],
      ['approved', 'yes'],
      ['reviewed HEAD', payload.packet.reviewedHeadSha ?? '(captured by server)'],
      ['merged', mergeRes.data.result.merged ? 'yes' : 'no'],
      ['note', mergeRes.data.result.note],
    ]);
  } else {
    printJson(payload);
  }

  return 0;
}
