import { apiFetch, CliError, EXIT } from '../../api.js';
import { resolveConfig } from '../../config.js';
import { detectWorktree, type WorktreeMatch } from './worktree-resolve.js';

export interface PacketArgumentSpec {
  command: string;
  valueFlags?: readonly string[];
  booleanFlags?: readonly string[];
  aliases?: Readonly<Record<string, string>>;
  allowTarget?: boolean;
  targetFlags?: readonly string[];
}

export interface ParsedPacketArguments {
  target: string | null;
  targetWasExplicit: boolean;
  values: Record<string, string>;
  booleans: Set<string>;
}

export interface PacketTargetLane {
  id: string;
  packetId: string | null;
  worktreePath: string | null;
  status?: string;
}

export interface ResolvedPacketTarget<T extends PacketTargetLane = PacketTargetLane> {
  input: string;
  explicit: boolean;
  laneId: string;
  packetId: string | null;
  worktreePath: string | null;
  lane: T;
}

const TERMINAL_LANE_STATUSES = new Set(['completed', 'archived', 'failed']);

function unexpectedArgument(command: string, argument: string, allowTarget: boolean): CliError {
  return new CliError(
    'invalid_args',
    `Unexpected argument ${argument} for o8 packet ${command}.`,
    EXIT.INVALID_ARGS,
    allowTarget
      ? `Pass one packet id positionally or with --packet <id>: o8 packet ${command} <packet-id>.`
      : `o8 packet ${command} does not accept a positional packet target.`,
  );
}

function requireFlagValue(rest: string[], index: number, flag: string): string {
  const value = rest[index + 1];
  if (!value || value.startsWith('-')) {
    throw new CliError(
      'invalid_args',
      `${flag} requires a value.`,
      EXIT.INVALID_ARGS,
    );
  }
  return value;
}

/**
 * Strict parser shared by packet verbs. It knows which flags consume values,
 * so a positional packet id can never be mistaken for (or silently discarded
 * behind) another option's value.
 */
export function parsePacketArguments(
  rest: string[],
  spec: PacketArgumentSpec,
): ParsedPacketArguments {
  const valueFlags = new Set(spec.valueFlags ?? []);
  const booleanFlags = new Set(spec.booleanFlags ?? []);
  const aliases = spec.aliases ?? {};
  const allowTarget = spec.allowTarget !== false;
  const targetFlags = new Set(spec.targetFlags ?? ['packet']);
  const values: Record<string, string> = {};
  const booleans = new Set<string>();
  let flagTarget: string | null = null;
  let positionalTarget: string | null = null;

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    const canonicalToken = aliases[token] ?? token;
    const flagName = canonicalToken.startsWith('--')
      ? canonicalToken.slice(2).split('=', 1)[0]
      : null;

    if (flagName && targetFlags.has(flagName)) {
      if (!allowTarget) throw unexpectedArgument(spec.command, token, false);
      const value = canonicalToken.includes('=')
        ? canonicalToken.slice(canonicalToken.indexOf('=') + 1)
        : requireFlagValue(rest, index, `--${flagName}`);
      if (!canonicalToken.includes('=')) index += 1;
      if (!value.trim()) {
        throw new CliError('invalid_args', `--${flagName} requires a value.`, EXIT.INVALID_ARGS);
      }
      if (flagTarget && flagTarget !== value.trim()) {
        throw new CliError(
          'invalid_args',
          `Conflicting explicit packet targets: ${flagTarget} and ${value.trim()}.`,
          EXIT.INVALID_ARGS,
        );
      }
      flagTarget = value.trim();
      continue;
    }

    if (flagName && valueFlags.has(flagName)) {
      const value = canonicalToken.includes('=')
        ? canonicalToken.slice(canonicalToken.indexOf('=') + 1)
        : requireFlagValue(rest, index, `--${flagName}`);
      if (!canonicalToken.includes('=')) index += 1;
      values[flagName] = value;
      continue;
    }

    if (flagName && booleanFlags.has(flagName)) {
      if (canonicalToken.includes('=')) {
        throw new CliError(
          'invalid_args',
          `--${flagName} does not take a value.`,
          EXIT.INVALID_ARGS,
        );
      }
      booleans.add(flagName);
      continue;
    }

    if (token.startsWith('-')) {
      throw new CliError(
        'invalid_args',
        `Unknown o8 packet ${spec.command} flag: ${token}.`,
        EXIT.INVALID_ARGS,
      );
    }

    if (!allowTarget || positionalTarget) {
      throw unexpectedArgument(spec.command, token, allowTarget);
    }
    positionalTarget = token.trim();
  }

  if (flagTarget && positionalTarget && flagTarget !== positionalTarget) {
    throw new CliError(
      'invalid_args',
      `Conflicting explicit packet targets: ${positionalTarget} and ${flagTarget}.`,
      EXIT.INVALID_ARGS,
      'Pass the target once, either positionally or with --packet <id>.',
    );
  }

  const target = positionalTarget || flagTarget;
  return {
    target: target || null,
    targetWasExplicit: Boolean(target),
    values,
    booleans,
  };
}

function chooseLane<T extends PacketTargetLane>(lanes: T[]): T | null {
  return lanes.find((lane) => !lane.status || !TERMINAL_LANE_STATUSES.has(lane.status))
    ?? lanes[0]
    ?? null;
}

/** Pure target resolver used by tests to prove explicit ids never fall back. */
export function resolvePacketTargetFromLanes<T extends PacketTargetLane>(
  explicitId: string | null,
  lanes: T[],
  cwdMatch: WorktreeMatch | null,
): ResolvedPacketTarget<T> {
  const normalized = explicitId?.trim() || null;
  if (normalized) {
    const lane = chooseLane(lanes.filter((candidate) => (
      candidate.id === normalized || candidate.packetId === normalized
    )));
    if (!lane) {
      throw new CliError(
        'packet_target_not_found',
        `Explicit packet target ${normalized} did not resolve to a registered packet or lane.`,
        EXIT.NOT_FOUND,
        'The cwd packet was not used because an explicit target was supplied. Run `o8 status` to confirm the id.',
      );
    }
    return {
      input: normalized,
      explicit: true,
      laneId: lane.id,
      packetId: lane.packetId,
      worktreePath: lane.worktreePath,
      lane,
    };
  }

  if (!cwdMatch) {
    throw new CliError(
      'not_in_packet_worktree',
      'No packet id given and the current directory is not inside a packet worktree.',
      EXIT.NOT_FOUND,
      'Pass a packet id or --packet <id>, or run from a `.cortex-worktrees/packet-<id>` worktree.',
    );
  }

  const lane = chooseLane(lanes.filter((candidate) => candidate.worktreePath === cwdMatch.worktreePath))
    ?? chooseLane(lanes.filter((candidate) => (
      Boolean(candidate.packetId) && cwdMatch.packetSlug.includes(candidate.packetId ?? '')
    )))
    ?? chooseLane(lanes.filter((candidate) => (
      Boolean(candidate.worktreePath) && candidate.worktreePath?.endsWith(`packet-${cwdMatch.packetSlug}`)
    )));
  if (!lane) {
    throw new CliError(
      'lane_not_found',
      `No lane registered for worktree ${cwdMatch.worktreePath}.`,
      EXIT.NOT_FOUND,
      'The lane may have been archived or the registry is out of sync. Run `o8 status` to confirm.',
    );
  }
  return {
    input: lane.packetId ?? lane.id,
    explicit: false,
    laneId: lane.id,
    packetId: lane.packetId,
    worktreePath: lane.worktreePath,
    lane,
  };
}

export async function resolvePacketTarget<T extends PacketTargetLane = PacketTargetLane>(
  explicitId: string | null,
): Promise<ResolvedPacketTarget<T>> {
  const cfg = resolveConfig();
  const response = await apiFetch<{ lanes: T[] }>(cfg, '/api/lanes', {
    query: { active: 'false' },
  });
  return resolvePacketTargetFromLanes(
    explicitId,
    response.data?.lanes ?? [],
    detectWorktree(process.cwd()),
  );
}

export function requirePacketId(target: ResolvedPacketTarget, command: string): string {
  if (target.packetId) return target.packetId;
  throw new CliError(
    'packet_target_not_found',
    `Target ${target.input} resolves to lane ${target.laneId}, but that lane has no packet id.`,
    EXIT.NOT_FOUND,
    `o8 packet ${command} requires a packet-bound lane.`,
  );
}
