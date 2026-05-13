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
  runtime: string;
  branch: string;
  repoPath: string;
  worktreePath: string | null;
  packetId: string | null;
  lastHeartbeatAt: number | null;
}

interface WorktreeMatch {
  worktreePath: string;
  packetSlug: string;
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

function parseLaneArg(rest: string[]): string | null {
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === '--lane') {
      return rest[++i]?.trim() || null;
    }
    if (tok.startsWith('--lane=')) {
      return tok.slice('--lane='.length).trim() || null;
    }
  }
  return null;
}

function resolveLane(lanes: Lane[], match: WorktreeMatch): Lane | null {
  return lanes.find((lane) => lane.worktreePath === match.worktreePath)
    ?? lanes.find((lane) => lane.packetId && match.packetSlug.includes(lane.packetId))
    ?? lanes.find((lane) => lane.worktreePath && lane.worktreePath.endsWith(`packet-${match.packetSlug}`))
    ?? null;
}

export async function runPacketHeartbeat(mode: OutputMode, rest: string[]): Promise<number> {
  const cfg = resolveConfig();
  const laneArg = parseLaneArg(rest);
  let laneId = laneArg;

  if (!laneId) {
    const match = detectWorktree(process.cwd());
    if (!match) {
      throw new CliError(
        'not_in_packet_worktree',
        'Current directory is not inside an o8 packet worktree.',
        EXIT.NOT_FOUND,
        'Run from `.cortex-worktrees/packet-<id>` or pass `--lane <lane-id>`.',
      );
    }

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
    laneId = lane.id;
  }

  const heartbeatAt = Date.now();
  const res = await apiFetch<{ ok: boolean; lane: Lane; heartbeatAt: number }>(
    cfg,
    `/api/lanes/${encodeURIComponent(laneId)}/heartbeat`,
    { method: 'POST', body: { heartbeatAt } },
  );
  const payload = res.data;
  if (!payload?.ok) {
    throw new CliError('heartbeat_failed', 'Packet heartbeat was rejected.', EXIT.CONFLICT);
  }

  const output = {
    schema: 'o8/cli/packet.heartbeat/v1',
    heartbeat: {
      laneId: payload.lane.id,
      packetId: payload.lane.packetId,
      status: payload.lane.status,
      heartbeatAt: payload.heartbeatAt,
    },
  };

  if (mode.human) {
    printHumanHeading('packet heartbeat');
    printHumanKv([
      ['lane', payload.lane.id],
      ['packet', payload.lane.packetId ?? '(none)'],
      ['status', payload.lane.status],
      ['heartbeat', new Date(payload.heartbeatAt).toISOString()],
    ]);
  } else {
    printJson(output);
  }

  return 0;
}
