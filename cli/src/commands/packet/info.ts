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

import { sep } from 'node:path';
import { apiFetch } from '../../api.js';
import { CliError, EXIT } from '../../api.js';
import { resolveConfig } from '../../config.js';
import {
  printHumanHeading,
  printHumanKv,
  printJson,
  type OutputMode,
} from '../../output.js';
import { warnRuntimeDriftIfNeeded } from './runtime-drift.js';

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
  layout: 'cortex-worktrees' | 'claude-worktrees';
}

interface PacketScopeRuntime {
  laneId: string;
  runtime: string;
  actualRuntime: string | null;
  worktreePath: string | null;
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
        layout: 'cortex-worktrees',
      };
    }
    if (prev === 'worktrees' && parts[i - 2] === '.claude') {
      return {
        worktreePath: parts.slice(0, i + 1).join(sep),
        packetSlug: cur.slice('packet-'.length),
        layout: 'claude-worktrees',
      };
    }
  }
  return null;
}

export async function runPacketInfo(mode: OutputMode): Promise<number> {
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
  const res = await apiFetch<{ lanes: Lane[] }>(cfg, '/api/lanes', { query: { active: 'false' } });
  const lanes = res.data?.lanes ?? [];

  // Prefer exact worktreePath match; fall back to packet slug substring.
  const exactMatch = lanes.find((l) => l.worktreePath === match.worktreePath);
  const slugMatch = exactMatch
    ?? lanes.find((l) => l.packetId && match.packetSlug.includes(l.packetId))
    ?? lanes.find((l) => l.worktreePath && l.worktreePath.endsWith(`packet-${match.packetSlug}`));

  if (!slugMatch) {
    throw new CliError(
      'lane_not_found',
      `No lane registered for worktree ${match.worktreePath}.`,
      EXIT.NOT_FOUND,
      'The lane may have been archived or the registry is out of sync. Run `o8 status` to confirm.',
    );
  }

  // Pull recent events to mirror the epic's sample shape.
  const eventsRes = await apiFetch<{ lane: Lane; events: LaneEvent[] }>(
    cfg,
    `/api/lanes/${encodeURIComponent(slugMatch.id)}`,
    { query: { events: 20 } },
  );
  const events = eventsRes.data?.events ?? [];
  const scopeRes = await apiFetch<PacketScopeRuntime>(
    cfg,
    `/api/lanes/${encodeURIComponent(slugMatch.id)}/scope`,
    { allowNotFound: true },
  ).catch(() => null);
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
      worktreeLayout: match.layout,
      createdAt: slugMatch.createdAt,
      updatedAt: slugMatch.updatedAt,
      lastEventAt: slugMatch.lastEventAt,
      lastEventLabel: slugMatch.lastEventLabel,
      events: events.map((e) => ({
        id: e.id,
        verb: e.verb,
        actor: e.actor,
        timestamp: e.timestamp,
        payload: e.payload,
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
