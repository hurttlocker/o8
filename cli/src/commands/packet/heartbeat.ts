import { apiFetch, CliError, EXIT } from '../../api.js';
import { resolveConfig } from '../../config.js';
import {
  printHumanHeading,
  printHumanKv,
  printJson,
  type OutputMode,
} from '../../output.js';
import { parsePacketArguments, resolvePacketTarget } from './target.js';

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

function parseLaneArg(rest: string[]): string | null {
  return parsePacketArguments(rest, {
    command: 'heartbeat',
    targetFlags: ['packet', 'lane'],
  }).target;
}

export async function runPacketHeartbeat(mode: OutputMode, rest: string[]): Promise<number> {
  const cfg = resolveConfig();
  const laneArg = parseLaneArg(rest);
  const laneId = (await resolvePacketTarget(laneArg)).laneId;

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
