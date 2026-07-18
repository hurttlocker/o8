/**
 * `o8 packet info` — info about the packet bound to the current worktree.
 *
 * Resolution: walk up from process.cwd() looking for the first parent path
 * segment that matches `.cortex-worktrees/packet-*` (the canonical layout
 * managed by src/lib/worktree/manager.ts) OR `.claude/worktrees/packet-*`
 * (legacy unmanaged Claude Code path that still backs lots of live lanes).
 * Once a worktree path is found, fetch all lanes and match by worktreePath.
 * If no match, fall back to packet-id extraction from the dir name.
 */

import { apiFetch } from '../../api.js';
import { resolveConfig } from '../../config.js';
import {
  printHumanHeading,
  printHumanKv,
  printJson,
  type OutputMode,
} from '../../output.js';
import { warnRuntimeDriftIfNeeded } from './runtime-drift.js';
import { detectWorktree } from './worktree-resolve.js';
import { parsePacketArguments, resolvePacketTarget } from './target.js';

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

interface PacketScopeRuntime {
  laneId: string;
  runtime: string;
  actualRuntime: string | null;
  worktreePath: string | null;
}

// Bound a single event payload so one large tool_result blob doesn't flood the
// agent's context when it pipes `o8 packet info` JSON in (20 events inlined).
const EVENT_PAYLOAD_CAP = 1000;
function capEventPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const json = JSON.stringify(payload);
  if (json.length <= EVENT_PAYLOAD_CAP) return payload;
  return { truncated: true, sizeChars: json.length, preview: json.slice(0, EVENT_PAYLOAD_CAP) };
}

export async function runPacketInfo(mode: OutputMode, rest: string[]): Promise<number> {
  const args = parsePacketArguments(rest, { command: 'info' });
  const target = await resolvePacketTarget<Lane>(args.target);
  const cfg = resolveConfig();
  const slugMatch = target.lane;
  const match = slugMatch.worktreePath ? detectWorktree(slugMatch.worktreePath) : null;

  // Recent events + scope are independent of each other (both only need the
  // lane id) — fetch them in parallel to halve the round-trips in a packet loop.
  const [eventsRes, scopeRes] = await Promise.all([
    apiFetch<{ lane: Lane; events: LaneEvent[] }>(
      cfg,
      `/api/lanes/${encodeURIComponent(slugMatch.id)}`,
      { query: { events: 20 } },
    ),
    apiFetch<PacketScopeRuntime>(
      cfg,
      `/api/lanes/${encodeURIComponent(slugMatch.id)}/scope`,
      { allowNotFound: true },
    ).catch(() => null),
  ]);
  const events = eventsRes.data?.events ?? [];
  const actualRuntime = scopeRes?.data?.actualRuntime ?? null;

  const payload = {
    schema: 'o8/cli/packet.info/v1',
    packet: {
      laneId: slugMatch.id,
      id: slugMatch.packetId ?? null,
      label: slugMatch.label,
      status: slugMatch.status,
      runtime: slugMatch.runtime,
      actualRuntime,
      branch: slugMatch.branch,
      baseBranch: slugMatch.baseBranch,
      repoPath: slugMatch.repoPath,
      worktreePath: slugMatch.worktreePath,
      worktreeLayout: match?.layout ?? null,
      createdAt: slugMatch.createdAt,
      updatedAt: slugMatch.updatedAt,
      lastEventAt: slugMatch.lastEventAt,
      lastEventLabel: slugMatch.lastEventLabel,
      events: events.map((e) => ({
        id: e.id,
        verb: e.verb,
        actor: e.actor,
        timestamp: e.timestamp,
        payload: capEventPayload(e.payload),
      })),
    },
  };

  warnRuntimeDriftIfNeeded({
    laneId: slugMatch.id,
    runtime: slugMatch.runtime,
    actualRuntime,
    worktreePath: slugMatch.worktreePath,
  }, mode);

  if (mode.human) {
    printHumanHeading('packet');
    printHumanKv([
      ['lane', slugMatch.id],
      ['packet', slugMatch.packetId ?? '(none)'],
      ['status', slugMatch.status],
      ['runtime', slugMatch.runtime],
      ['actual runtime', actualRuntime ?? '(pending)'],
      ['branch', slugMatch.branch],
      ['base', slugMatch.baseBranch],
      ['repo', slugMatch.repoPath],
      ['worktree', slugMatch.worktreePath ?? '(none)'],
      ['label', slugMatch.label],
    ]);
    if (events.length > 0) {
      printHumanHeading(`recent events (${events.length})`);
      for (const e of events) {
        process.stdout.write(`  ${e.timestamp}  ${e.actor.padEnd(13)} ${e.verb}\n`);
      }
    }
  } else {
    printJson(payload);
  }
  return 0;
}
