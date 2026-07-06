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
import { resolveLaneFromCwd } from './worktree-resolve.js';

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

interface StopArgs {
  packetId: string | null;
}

const TERMINAL_STATUSES = new Set(['completed', 'archived']);

function flagValue(rest: string[], index: number, name: string): string {
  const value = rest[index + 1];
  if (!value || value.startsWith('--')) {
    throw new CliError(
      'invalid_args',
      `--${name} requires a value.`,
      EXIT.INVALID_ARGS,
      `Example: o8 packet stop --${name} pkt-123`,
    );
  }
  return value;
}

export function parsePacketStopArgs(rest: string[]): StopArgs {
  let packetFlag: string | null = null;
  const positionals: string[] = [];

  for (let i = 0; i < rest.length; i += 1) {
    const tok = rest[i];
    if (tok === '--packet') {
      packetFlag = flagValue(rest, i, 'packet');
      i += 1;
    } else if (tok.startsWith('--packet=')) {
      packetFlag = tok.slice('--packet='.length);
    } else if (tok.startsWith('-')) {
      throw new CliError('invalid_args', `Unknown packet stop flag: ${tok}`, EXIT.INVALID_ARGS);
    } else {
      positionals.push(tok);
    }
  }

  if (positionals.length > 1) {
    throw new CliError(
      'invalid_args',
      `Unexpected positional arguments: ${positionals.slice(1).join(' ')}`,
      EXIT.INVALID_ARGS,
      'usage: o8 packet stop <packetId>  or  o8 packet stop --packet <packetId>',
    );
  }

  return { packetId: (positionals[0] ?? packetFlag)?.trim() || null };
}

async function resolveTargetLane(packetId: string | null): Promise<{ packetId: string; laneId: string }> {
  const cfg = resolveConfig();
  if (!packetId) {
    const resolved = await resolveLaneFromCwd();
    if (!resolved?.packetId) {
      throw new CliError(
        'not_in_packet_worktree',
        'No packet id given and the current directory is not inside a packet worktree.',
        EXIT.NOT_FOUND,
        'Pass a packet id, pass --packet <id>, or run from a `.cortex-worktrees/packet-<id>` worktree.',
      );
    }
    return { packetId: resolved.packetId, laneId: resolved.laneId };
  }

  const res = await apiFetch<{ lanes: Lane[] }>(cfg, '/api/lanes', { query: { active: 'false' } });
  const lanes = res.data?.lanes ?? [];
  const lane = lanes.find((candidate) => (
    candidate.packetId === packetId && !TERMINAL_STATUSES.has(candidate.status)
  )) ?? lanes.find((candidate) => candidate.packetId === packetId);

  if (!lane) {
    throw new CliError(
      'packet_lane_not_found',
      `No lane is registered for packet ${packetId}.`,
      EXIT.NOT_FOUND,
      'Run `o8 status` or `o8 packet info` from the packet worktree to confirm the packet id.',
    );
  }
  return { packetId, laneId: lane.id };
}

function confirmedDead(result: LaneCommandResult | null | undefined): boolean | null {
  if (typeof result?.confirmedDead === 'boolean') return result.confirmedDead;
  if (typeof result?.processDead === 'boolean') return result.processDead;
  return null;
}

export async function runPacketStop(mode: OutputMode, rest: string[]): Promise<number> {
  const args = parsePacketStopArgs(rest);
  const target = await resolveTargetLane(args.packetId);
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
