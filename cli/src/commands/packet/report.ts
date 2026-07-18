import { apiFetch, CliError, EXIT } from '../../api.js';
import { resolveConfig } from '../../config.js';
import {
  printHumanHeading,
  printHumanKv,
  printJson,
  type OutputMode,
} from '../../output.js';
import { parsePacketArguments, resolvePacketTarget } from './target.js';

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

interface ReportArgs {
  packetId: string | null;
  event: string | null;
  reason: string | null;
  message: string | null;
  metadata: Record<string, unknown> | null;
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
  const args = parsePacketArguments(rest, {
    command: 'report',
    valueFlags: ['event', 'reason', 'message', 'meta'],
  });

  return {
    packetId: args.target,
    event: args.values.event?.trim() || null,
    reason: args.values.reason?.trim() || null,
    message: args.values.message?.trim() || null,
    metadata: parseMetadata(args.values.meta ?? null),
  };
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

  const target = await resolvePacketTarget(args.packetId);
  const cfg = resolveConfig();
  const reportRes = await apiFetch<{
    ok: boolean;
    lane: Lane;
    event: LaneEvent;
    statusChanged: boolean;
  }>(cfg, `/api/lanes/${encodeURIComponent(target.laneId)}/events`, {
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
