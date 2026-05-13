import { sep } from 'node:path';
import { apiFetch, CliError, EXIT } from '../../api.js';
import { resolveConfig } from '../../config.js';
import {
  printHumanHeading,
  printHumanKv,
  printJson,
  type OutputMode,
} from '../../output.js';

const AGENT_REPORT_REASONS = new Set([
  'needs_clarification',
  'missing_context',
  'out_of_scope',
  'dependency_blocked',
  'context_full',
  'nondeterministic_test',
  'external_api_down',
  'unknown',
]);

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
  createdAt: string;
  updatedAt: string;
  lastEventAt: string | null;
  lastEventLabel: string | null;
}

interface LaneEvent {
  id: string;
  verb: string;
  actor: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

interface WorktreeMatch {
  worktreePath: string;
  packetSlug: string;
}

interface ReportArgs {
  event: string | null;
  reason: string | null;
  message: string | null;
  metadata: Record<string, unknown> | null;
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

function parseMetadata(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError('invalid_args', '--meta must be valid JSON.', EXIT.INVALID_ARGS);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliError('invalid_args', '--meta must be a JSON object.', EXIT.INVALID_ARGS);
  }
  return parsed as Record<string, unknown>;
}

export function parseReportArgs(rest: string[]): ReportArgs {
  let event: string | null = null;
  let reason: string | null = null;
  let message: string | null = null;
  let metaRaw: string | null = null;

  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === '--event') {
      event = rest[++i] ?? null;
    } else if (tok.startsWith('--event=')) {
      event = tok.slice('--event='.length);
    } else if (tok === '--reason') {
      reason = rest[++i] ?? null;
    } else if (tok.startsWith('--reason=')) {
      reason = tok.slice('--reason='.length);
    } else if (tok === '--message') {
      message = rest[++i] ?? null;
    } else if (tok.startsWith('--message=')) {
      message = tok.slice('--message='.length);
    } else if (tok === '--meta') {
      metaRaw = rest[++i] ?? null;
    } else if (tok.startsWith('--meta=')) {
      metaRaw = tok.slice('--meta='.length);
    } else if (!tok.startsWith('--') && !message) {
      message = tok;
    }
  }

  return {
    event: event?.trim() || null,
    reason: reason?.trim() || null,
    message: message?.trim() || null,
    metadata: parseMetadata(metaRaw),
  };
}

function resolveLane(lanes: Lane[], match: WorktreeMatch): Lane | null {
  return lanes.find((lane) => lane.worktreePath === match.worktreePath)
    ?? lanes.find((lane) => lane.packetId && match.packetSlug.includes(lane.packetId))
    ?? lanes.find((lane) => lane.worktreePath && lane.worktreePath.endsWith(`packet-${match.packetSlug}`))
    ?? null;
}

export async function runPacketReport(mode: OutputMode, rest: string[]): Promise<number> {
  const args = parseReportArgs(rest);
  if (!args.event) {
    throw new CliError(
      'invalid_args',
      'o8 packet report --event <kind> requires an event.',
      EXIT.INVALID_ARGS,
      'Example: o8 packet report --event blocked --reason needs_clarification --message "Need product direction."',
    );
  }
  if (args.reason && !AGENT_REPORT_REASONS.has(args.reason)) {
    throw new CliError(
      'invalid_args',
      `Unknown report reason: ${args.reason}`,
      EXIT.INVALID_ARGS,
      'Use one of: needs_clarification, missing_context, out_of_scope, dependency_blocked, context_full, nondeterministic_test, external_api_down, unknown.',
    );
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

  const reportRes = await apiFetch<{
    ok: boolean;
    lane: Lane;
    event: LaneEvent;
    statusChanged: boolean;
  }>(cfg, `/api/lanes/${encodeURIComponent(lane.id)}/events`, {
    method: 'POST',
    body: {
      verb: 'agent_report',
      event: args.event,
      reason: args.reason ?? undefined,
      message: args.message ?? undefined,
      metadata: args.metadata ?? undefined,
    },
  });
  const report = reportRes.data;
  if (!report?.ok) {
    throw new CliError('report_failed', 'Packet report was rejected.', EXIT.CONFLICT);
  }

  const payload = {
    schema: 'o8/cli/packet.report/v1',
    report: {
      laneId: report.lane.id,
      packetId: report.lane.packetId,
      eventId: report.event.id,
      event: args.event,
      reason: args.reason,
      message: args.message,
      status: report.lane.status,
      statusChanged: report.statusChanged,
    },
  };

  if (mode.human) {
    printHumanHeading('packet report');
    printHumanKv([
      ['lane', report.lane.id],
      ['packet', report.lane.packetId ?? '(none)'],
      ['event', args.event],
      ['reason', args.reason ?? '(none)'],
      ['status', report.lane.status],
      ['changed', report.statusChanged ? 'yes' : 'no'],
    ]);
  } else {
    printJson(payload);
  }
  return 0;
}
