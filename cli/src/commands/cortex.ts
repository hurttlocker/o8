import { sep } from 'node:path';
import { apiFetch, CliError, EXIT } from '../api.js';
import { resolveConfig } from '../config.js';
import {
  printHumanHeading,
  printHumanKv,
  printJson,
  type OutputMode,
} from '../output.js';

const OBSERVATION_KINDS = new Set(['regression', 'pattern', 'gotcha', 'preference']);
const OBSERVATION_SCOPES = new Set(['packet', 'repo', 'global']);

interface Lane {
  id: string;
  label: string;
  status: string;
  runtime: string;
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

interface ObserveArgs {
  kind: string | null;
  text: string | null;
  scope: string;
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

function parseObserveArgs(rest: string[]): ObserveArgs {
  let kind: string | null = null;
  let text: string | null = null;
  let scope = 'packet';

  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === '--kind') {
      kind = rest[++i] ?? null;
    } else if (tok.startsWith('--kind=')) {
      kind = tok.slice('--kind='.length);
    } else if (tok === '--text') {
      text = rest[++i] ?? null;
    } else if (tok.startsWith('--text=')) {
      text = tok.slice('--text='.length);
    } else if (tok === '--scope') {
      scope = rest[++i] ?? '';
    } else if (tok.startsWith('--scope=')) {
      scope = tok.slice('--scope='.length);
    } else if (!tok.startsWith('--') && !text) {
      text = tok;
    }
  }

  return {
    kind: kind?.trim() || null,
    text: text?.trim() || null,
    scope: scope.trim() || 'packet',
  };
}

function resolveLane(lanes: Lane[], match: WorktreeMatch): Lane | null {
  return lanes.find((lane) => lane.worktreePath === match.worktreePath)
    ?? lanes.find((lane) => lane.packetId && match.packetSlug.includes(lane.packetId))
    ?? lanes.find((lane) => lane.worktreePath && lane.worktreePath.endsWith(`packet-${match.packetSlug}`))
    ?? null;
}

export async function runCortexObserve(mode: OutputMode, rest: string[]): Promise<number> {
  const args = parseObserveArgs(rest);
  if (!args.kind || !OBSERVATION_KINDS.has(args.kind)) {
    throw new CliError(
      'invalid_args',
      'o8 cortex observe --kind requires regression, pattern, gotcha, or preference.',
      EXIT.INVALID_ARGS,
    );
  }
  if (!args.text) {
    throw new CliError('invalid_args', 'o8 cortex observe --text requires observation text.', EXIT.INVALID_ARGS);
  }
  if (!OBSERVATION_SCOPES.has(args.scope)) {
    throw new CliError('invalid_args', '--scope must be packet, repo, or global.', EXIT.INVALID_ARGS);
  }

  const match = detectWorktree(process.cwd());
  if (!match) {
    throw new CliError(
      'not_in_packet_worktree',
      'Current directory is not inside an o8 packet worktree.',
      EXIT.NOT_FOUND,
      'Expected a path containing `.cortex-worktrees/packet-<id>` or `.claude/worktrees/packet-<id>`.',
    );
  }

  const cfg = resolveConfig();
  const lanesRes = await apiFetch<{ lanes: Lane[] }>(cfg, '/api/lanes', { query: { active: 'false' } });
  const lane = resolveLane(lanesRes.data?.lanes ?? [], match);
  if (!lane) {
    throw new CliError(
      'lane_not_found',
      `No lane registered for worktree ${match.worktreePath}.`,
      EXIT.NOT_FOUND,
      'The lane may have been archived or the registry is out of sync. Run `o8 status` to confirm.',
    );
  }

  const packetId = lane.packetId ?? match.packetSlug;
  const proposalRes = await apiFetch<{ ok?: boolean; proposal?: { id?: string; proposed_by?: string } }>(
    cfg,
    '/api/cortex/proposals',
    {
      method: 'POST',
      body: {
        action: 'propose_observation',
        packetId,
        laneId: lane.id,
        proposed_by: packetId,
        kind: args.kind,
        text: args.text,
        scope: args.scope,
      },
    },
  );
  const proposal = proposalRes.data?.proposal;
  if (!proposalRes.data?.ok || !proposal?.id) {
    throw new CliError('proposal_failed', 'Observation proposal was rejected.', EXIT.CONFLICT);
  }

  const payload = {
    schema: 'o8/cli/cortex.observe/v1',
    proposal: {
      id: proposal.id,
      packetId,
      laneId: lane.id,
      proposedBy: proposal.proposed_by ?? packetId,
      kind: args.kind,
      scope: args.scope,
    },
  };

  if (mode.human) {
    printHumanHeading('cortex observation');
    printHumanKv([
      ['proposal', proposal.id],
      ['packet', packetId],
      ['lane', lane.id],
      ['kind', args.kind],
      ['scope', args.scope],
    ]);
  } else {
    printJson(payload);
  }
  return 0;
}
