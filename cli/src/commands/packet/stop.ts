/**
 * `o8 packet stop|cancel <packetId|--packet id>` — hard-stop a packet lane.
 *
 * Resolves packet id to the registered lane, then calls the canonical lane
 * command bus with verb:stop. Explicit ids always win over cwd resolution.
 */

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
  packetId: string | null;
  status: string;
  sessionKey?: string | null;
  lastEventLabel?: string | null;
}

interface LaneCommandResult {
  ok: boolean;
  laneId: string;
  note: string;
  lane?: Lane;
  processDead?: boolean;
  confirmedDead?: boolean;
  [key: string]: unknown;
}

export interface StopArgs {
  packetId: string | null;
}

export function parsePacketStopArgs(rest: string[]): StopArgs {
  return {
    packetId: parsePacketArguments(rest, { command: 'stop' }).target,
  };
}

function confirmedDead(result: LaneCommandResult | null | undefined): boolean | null {
  if (typeof result?.confirmedDead === 'boolean') return result.confirmedDead;
  if (typeof result?.processDead === 'boolean') return result.processDead;
  return null;
}

export async function runPacketStop(mode: OutputMode, rest: string[]): Promise<number> {
  const args = parsePacketStopArgs(rest);
  const resolved = await resolvePacketTarget(args.packetId);
  if (!resolved.packetId) {
    throw new CliError(
      'packet_target_not_found',
      `Target ${resolved.input} resolves to a lane without a packet id.`,
      EXIT.NOT_FOUND,
    );
  }
  const target = { packetId: resolved.packetId, laneId: resolved.laneId };
  const cfg = resolveConfig();
  const res = await apiFetch<LaneCommandResult>(cfg, '/api/lanes', {
    method: 'POST',
    body: { verb: 'stop', laneId: target.laneId },
  });
  const result = res.data;
  const dead = confirmedDead(result);

  const payload = {
    schema: 'o8/cli/packet.stop/v1',
    packet: { id: target.packetId, laneId: target.laneId },
    result,
    confirmedDead: dead,
  };
  if (mode.human) {
    printHumanHeading('packet stop');
    printHumanKv([
      ['packet', target.packetId],
      ['lane', target.laneId],
      ['ok', result?.ok ? 'yes' : 'no'],
      ['confirmed dead', dead === null ? '(not reported)' : dead ? 'yes' : 'no'],
      ['note', result?.note ?? 'Packet stop was rejected.'],
    ]);
  } else {
    printJson(payload);
  }
  if (!result?.ok) {
    return EXIT.CONFLICT;
  }
  return 0;
}
