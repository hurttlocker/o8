/**
 * `o8 mission …` — mission lifecycle from the CLI.
 *
 * CLI-as-control-plane symmetry (Stage 1). These verbs lived
 * only in the operator MCP server; they are thin clients of the same gated
 * `/api/orchestrator/*` routes the MCP already calls, so the human operator
 * (headless) and a self-orchestrating agent both drive a mission from one
 * binary. No business logic here — fetch + JSON shape, per the CLI charter.
 *
 *   o8 mission create   --title "…" [--body "…"] [--repo <path>] [--runtime r]
 *                       [--model m] [--constraints "…"] [--sequential]
 *                       [--compare m1,m2] [--huddle] [--brain] [--number n]
 *                       [--quality-search-contract <json-file>]
 *   o8 mission dispatch [--mission <id>]
 *   o8 mission status   [--mission <id>] [--cost]
 *   o8 mission stop     --mission <id>
 *   o8 mission wait     [--mission <id>] [--packet <id>] [--timeout <ms|5m|90s>] [--poll ms]
 *   o8 mission tail     [--mission <id>] [--timeout <ms|5m|90s>] [--poll ms]
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { apiFetch, CliError, EXIT, SLOW_MUTATION_TIMEOUT_MS } from '../api.js';
import { resolveConfig } from '../config.js';
import {
  printHumanHeading,
  printHumanKv,
  printJson,
  type OutputMode,
} from '../output.js';

interface OperatorResponse<T> {
  ok: boolean;
  result?: T;
  error?: { message?: string } | string;
}

interface CreateMissionResult {
  missionId: string;
  packets: Array<{ id: string; title: string; wave: number }>;
  branchPreparation?: unknown[];
}

interface MissionStatusPacket {
  id: string;
  title?: string;
  status?: string;
  wave?: number;
}

interface MissionStatusResult {
  missionId: string;
  packets?: MissionStatusPacket[];
  [key: string]: unknown;
}

interface MissionStopResult {
  missionId: string;
  event?: {
    type?: string;
    recordedAt?: string;
  };
  packets: Array<{
    packetId: string;
    status: string;
    laneId: string | null;
    note?: string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

// Mirror of PACKET_ATTENTION_STATUSES in operator-handlers/mission.ts — the set
// `wait_for_mission_ready` treats as "needs the operator's attention". Kept in
// sync by the Stage-7 parity audit; duplicated here because the CLI is a
// standalone bundle that cannot import from `@/lib`. `blocked` is included
// (#1467): huddles, silent-exit parks, and dispatch failures all land there and
// none progress without a decision — a watcher that sleeps through them
// deadlocks against its own worker. Dependency-held packets stay `queued`.
const PACKET_TERMINAL_STATUSES = new Set(['awaiting_review', 'released', 'failed', 'archived', 'blocked']);

/**
 * Duration flag parser — accepts `90s` / `45m` / `2h` suffixes, or a bare
 * number in MILLISECONDS (backward compat). The bare-ms contract silently ate
 * watchers (live-hit 2026-07-12: `--timeout 3600` read as 3.6 SECONDS, the
 * watch died instantly, and the spawning agent never heard the packet hit
 * review). Cap 6h — long worker runs must be watchable end to end.
 */
const DURATION_CAP_MS = 6 * 60 * 60 * 1000;
export function parseDurationMs(raw: string | null | undefined, defaultMs: number): number {
  const trimmed = raw?.trim() ?? '';
  if (!trimmed) return defaultMs;
  const match = trimmed.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i);
  if (!match) return defaultMs;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return defaultMs;
  const unit = (match[2] ?? 'ms').toLowerCase();
  const ms = unit === 'h' ? value * 3_600_000 : unit === 'm' ? value * 60_000 : unit === 's' ? value * 1000 : value;
  return Math.max(1000, Math.min(DURATION_CAP_MS, ms));
}

function flag(rest: string[], name: string): string | null {
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === `--${name}`) return rest[i + 1] ?? '';
    if (tok.startsWith(`--${name}=`)) return tok.slice(name.length + 3);
  }
  return null;
}

function hasFlag(rest: string[], name: string): boolean {
  return rest.includes(`--${name}`);
}

export function parseMissionStopArgs(rest: string[]): { missionId: string } {
  let missionId: string | null = null;
  for (let i = 0; i < rest.length; i += 1) {
    const tok = rest[i];
    if (tok === '--mission') {
      const value = rest[i + 1];
      if (!value || value.startsWith('--')) {
        throw new CliError('invalid_args', '--mission requires a value.', EXIT.INVALID_ARGS);
      }
      missionId = value;
      i += 1;
    } else if (tok.startsWith('--mission=')) {
      missionId = tok.slice('--mission='.length);
    } else {
      throw new CliError(
        'invalid_args',
        `Unexpected mission stop argument: ${tok}`,
        EXIT.INVALID_ARGS,
        'usage: o8 mission stop --mission <missionId>',
      );
    }
  }
  if (!missionId?.trim()) {
    throw new CliError(
      'invalid_args',
      'o8 mission stop requires --mission.',
      EXIT.INVALID_ARGS,
      'Example: o8 mission stop --mission mission-abc123',
    );
  }
  return { missionId: missionId.trim() };
}

function responseError(payload: OperatorResponse<unknown> | null | undefined, fallback: string): string {
  const error = payload?.error;
  if (typeof error === 'string' && error.trim()) return error;
  if (error && typeof error === 'object' && typeof error.message === 'string' && error.message.trim()) {
    return error.message;
  }
  return fallback;
}

function unwrap<T>(payload: OperatorResponse<T> | null, fallback: string): T {
  if (!payload?.ok || payload.result === undefined) {
    throw new CliError('mission_failed', responseError(payload, fallback), EXIT.CONFLICT);
  }
  return payload.result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function packetSignature(packets: MissionStatusPacket[] | undefined): string {
  return (packets ?? []).map((p) => `${p.id}:${p.status ?? ''}`).sort().join('|');
}

async function runMissionCreate(mode: OutputMode, rest: string[]): Promise<number> {
  const title = flag(rest, 'title');
  if (!title?.trim()) {
    throw new CliError(
      'invalid_args',
      'o8 mission create requires --title.',
      EXIT.INVALID_ARGS,
      'Example: o8 mission create --title "Add a health route" --body "Create /api/health returning 200."',
    );
  }
  const repoPath = flag(rest, 'repo')?.trim() || process.cwd();
  const numberRaw = flag(rest, 'number');
  // Inline tasks need a positive issue number the service accepts. Synthesize a
  // high synthetic number when the caller didn't supply one (matches the
  // >=90001 convention used elsewhere for inline dispatch).
  const number = numberRaw && Number.isFinite(Number(numberRaw))
    ? Number(numberRaw)
    : 90001 + (Date.now() % 9000);

  const compareRaw = flag(rest, 'compare');
  const comparisonModels = compareRaw
    ? compareRaw.split(',').map((m) => m.trim()).filter(Boolean)
    : undefined;
  const qualitySearchContractPath = flag(rest, 'quality-search-contract')?.trim();
  if (qualitySearchContractPath && comparisonModels?.length) {
    throw new CliError('invalid_args', '--quality-search-contract cannot be combined with --compare.', EXIT.INVALID_ARGS);
  }
  if (qualitySearchContractPath && hasFlag(rest, 'huddle')) {
    throw new CliError('invalid_args', '--quality-search-contract cannot be combined with --huddle.', EXIT.INVALID_ARGS);
  }
  let qualitySearch: { taskContract: unknown } | undefined;
  if (qualitySearchContractPath) {
    try {
      qualitySearch = {
        taskContract: JSON.parse(readFileSync(resolve(qualitySearchContractPath), 'utf8')) as unknown,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CliError('invalid_args', `Unable to read quality-search contract: ${message}`, EXIT.INVALID_ARGS);
    }
  }

  const body: Record<string, unknown> = {
    repoPath,
    issues: [{ number, title: title.trim(), body: flag(rest, 'body')?.trim() || '', url: '' }],
  };
  const runtime = flag(rest, 'runtime');
  if (runtime) body.runtime = runtime;
  const model = flag(rest, 'model');
  if (model) body.model = model;
  const constraints = flag(rest, 'constraints');
  if (constraints) body.constraints = constraints;
  if (hasFlag(rest, 'sequential')) body.sequential = true;
  if (hasFlag(rest, 'huddle')) body.huddle = true;
  if (hasFlag(rest, 'brain')) body.useBrain = true;
  if (comparisonModels && comparisonModels.length > 0) body.comparisonModels = comparisonModels;
  if (qualitySearch) body.qualitySearch = qualitySearch;

  const cfg = resolveConfig();
  const res = await apiFetch<OperatorResponse<CreateMissionResult>>(cfg, '/api/orchestrator/create-mission', {
    method: 'POST',
    body,
  });
  const result = unwrap(res.data, 'Mission creation was rejected.');

  const payload = { schema: 'o8/cli/mission.create/v1', mission: result };
  if (mode.human) {
    printHumanHeading('mission create');
    printHumanKv([
      ['mission', result.missionId],
      ['packets', String(result.packets.length)],
      ...result.packets.map((p) => [`  · ${p.id}`, `${p.title} (wave ${p.wave})`] as [string, string]),
    ]);
  } else {
    printJson(payload);
  }
  return 0;
}

async function runMissionDispatch(mode: OutputMode, rest: string[]): Promise<number> {
  const missionId = flag(rest, 'mission')?.trim() || undefined;
  // Default async: launching workers (Codex spawn + worktrees) takes minutes;
  // returning once dispatch is initiated keeps the CLI snappy. `--wait` blocks
  // for the full launch + the dispatched-count. Either way, `o8 mission status`
  // / `o8 mission wait` track progress.
  const wait = hasFlag(rest, 'wait');
  const cfg = resolveConfig();
  const res = await apiFetch<OperatorResponse<{ initiated?: boolean; dispatched?: number }>>(cfg, '/api/orchestrator/dispatch', {
    method: 'POST',
    timeoutMs: wait ? SLOW_MUTATION_TIMEOUT_MS : undefined,
    body: { ...(missionId ? { missionId } : {}), wait },
  });
  const result = unwrap(res.data, 'Mission dispatch was rejected.');

  const payload = { schema: 'o8/cli/mission.dispatch/v1', dispatch: result };
  if (mode.human) {
    printHumanHeading('mission dispatch');
    printHumanKv([
      ['mission', missionId ?? '(active)'],
      ['result', wait ? `dispatched ${result.dispatched ?? '?'} packet(s)` : 'initiated (track: o8 mission status)'],
    ]);
  } else {
    printJson(payload);
  }

  // --watch: dispatch-and-notify in ONE command (Q ruling 2026-07-12: the
  // spawner must hear the packet hit review INSTANTLY, not via hand-rolled
  // pollers). Blocks until any packet reaches a terminal/review status, then
  // exits — a backgrounded `dispatch --watch` becomes the notification. Long
  // default (2h) so a real worker run can't outlive its watcher silently.
  if (hasFlag(rest, 'watch')) {
    const watchMs = parseDurationMs(flag(rest, 'timeout'), 2 * 60 * 60 * 1000);
    const pollMs = Math.max(1000, Number(flag(rest, 'poll')) || 5000);
    const deadline = Date.now() + watchMs;
    let terminal: { id: string; status?: string; title?: string } | null = null;
    while (Date.now() < deadline) {
      const snapshot = await fetchStatus(missionId, false);
      terminal = (snapshot.packets ?? []).find(
        (p) => typeof p.status === 'string' && PACKET_TERMINAL_STATUSES.has(p.status),
      ) ?? null;
      if (terminal) break;
      await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    }
    const watchPayload = {
      schema: 'o8/cli/mission.dispatch.watch/v1',
      wakeReason: terminal ? 'packet-terminal' : 'timeout',
      packetId: terminal?.id ?? null,
      status: terminal?.status ?? null,
      title: terminal?.title ?? null,
    };
    if (mode.human) {
      printHumanKv([
        ['watch', terminal ? `${terminal.id} → ${terminal.status}` : 'timeout — still running'],
      ]);
    } else {
      printJson(watchPayload);
    }
  }
  return 0;
}

async function fetchStatus(missionId: string | undefined, includeCost: boolean): Promise<MissionStatusResult> {
  const cfg = resolveConfig();
  const res = await apiFetch<OperatorResponse<MissionStatusResult>>(cfg, '/api/orchestrator/status', {
    query: { ...(missionId ? { missionId } : {}), ...(includeCost ? { includeCost: 'true' } : {}) },
  });
  return unwrap(res.data, 'Unable to read mission status.');
}

async function runMissionStatus(mode: OutputMode, rest: string[]): Promise<number> {
  const missionId = flag(rest, 'mission')?.trim() || undefined;
  const result = await fetchStatus(missionId, hasFlag(rest, 'cost'));

  const payload = { schema: 'o8/cli/mission.status/v1', status: result };
  if (mode.human) {
    printHumanHeading('mission status');
    printHumanKv([
      ['mission', result.missionId || '(none)'],
      ...(result.packets ?? []).map((p) => [`  · ${p.id}`, `${p.status ?? '?'} — ${p.title ?? ''}`] as [string, string]),
    ]);
  } else {
    printJson(payload);
  }
  return 0;
}

async function runMissionStop(mode: OutputMode, rest: string[]): Promise<number> {
  const { missionId } = parseMissionStopArgs(rest);
  const cfg = resolveConfig();
  const res = await apiFetch<OperatorResponse<MissionStopResult>>(cfg, '/api/orchestrator/stop-mission', {
    method: 'POST',
    body: { missionId },
  });
  const result = unwrap(res.data, 'Mission stop was rejected.');

  const payload = { schema: 'o8/cli/mission.stop/v1', mission: result };
  if (mode.human) {
    printHumanHeading('mission stop');
    printHumanKv([
      ['mission', result.missionId],
      ['packets', String(result.packets.length)],
      ...result.packets.map((item) => [
        `  · ${item.packetId}`,
        `${item.status}${item.laneId ? ` · ${item.laneId}` : ''}${item.note ? ` · ${item.note}` : ''}`,
      ] as [string, string]),
    ]);
  } else {
    printJson(payload);
  }
  return 0;
}

async function runMissionWait(mode: OutputMode, rest: string[]): Promise<number> {
  const missionId = flag(rest, 'mission')?.trim() || undefined;
  const packetFilter = flag(rest, 'packet')?.trim() || null;
  const timeoutMs = parseDurationMs(flag(rest, 'timeout'), 10 * 60 * 1000);
  const pollMs = Math.max(1000, Number(flag(rest, 'poll')) || 3000);

  const terminalOf = (s: MissionStatusResult) => (s.packets ?? []).find(
    (p) => (!packetFilter || p.id === packetFilter) && typeof p.status === 'string' && PACKET_TERMINAL_STATUSES.has(p.status),
  ) ?? null;

  const baseline = await fetchStatus(missionId, false);
  let snapshot = baseline;
  let wakeReason: 'already-terminal' | 'state-change' | 'timeout' = 'timeout';
  const baselineTerminal = terminalOf(baseline);
  if (baselineTerminal) {
    wakeReason = 'already-terminal';
  } else {
    const baselineSig = packetSignature(baseline.packets);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
      if (Date.now() >= deadline) break;
      const next = await fetchStatus(missionId, false);
      snapshot = next;
      if (terminalOf(next) || packetSignature(next.packets) !== baselineSig) {
        wakeReason = 'state-change';
        break;
      }
    }
  }

  const terminalPacket = terminalOf(snapshot);
  const payload = {
    schema: 'o8/cli/mission.wait/v1',
    wakeReason,
    terminalPacketId: terminalPacket?.id ?? null,
    status: snapshot,
  };
  if (mode.human) {
    printHumanHeading('mission wait');
    printHumanKv([
      ['mission', snapshot.missionId || '(none)'],
      ['wake', wakeReason],
      ['terminal packet', terminalPacket?.id ?? '(none)'],
      ...(snapshot.packets ?? []).map((p) => [`  · ${p.id}`, p.status ?? '?'] as [string, string]),
    ]);
  } else {
    printJson(payload);
  }
  // Timeout is a soft outcome, not an error — exit 0 with wakeReason so the
  // caller branches on the field, not the code.
  return 0;
}

async function runMissionTail(mode: OutputMode, rest: string[]): Promise<number> {
  const missionId = flag(rest, 'mission')?.trim() || undefined;
  const timeoutMs = parseDurationMs(flag(rest, 'timeout'), 10 * 60 * 1000);
  const pollMs = Math.max(1000, Number(flag(rest, 'poll')) || 3000);

  const deadline = Date.now() + timeoutMs;
  const lastStatus = new Map<string, string>();
  let allTerminal = false;

  const emit = (event: Record<string, unknown>) => {
    if (mode.human) {
      process.stdout.write(`${String(event.packetId)}  ${String(event.from ?? '∅')} → ${String(event.status)}\n`);
    } else {
      printJson({ schema: 'o8/cli/mission.tail.event/v1', ...event });
    }
  };

  while (Date.now() < deadline && !allTerminal) {
    const snapshot = await fetchStatus(missionId, false);
    const packets = snapshot.packets ?? [];
    for (const p of packets) {
      const prev = lastStatus.get(p.id);
      const cur = p.status ?? '?';
      if (prev !== cur) {
        emit({ packetId: p.id, from: prev ?? null, status: cur, title: p.title ?? '' });
        lastStatus.set(p.id, cur);
      }
    }
    allTerminal = packets.length > 0 && packets.every(
      (p) => typeof p.status === 'string' && PACKET_TERMINAL_STATUSES.has(p.status),
    );
    if (allTerminal) break;
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }

  if (!mode.human) {
    printJson({ schema: 'o8/cli/mission.tail/v1', done: allTerminal, reason: allTerminal ? 'all-terminal' : 'timeout' });
  }
  return 0;
}

export async function runMission(mode: OutputMode, secondary: string | undefined, rest: string[]): Promise<number> {
  switch (secondary) {
    case 'create':
      return runMissionCreate(mode, rest);
    case 'dispatch':
      return runMissionDispatch(mode, rest);
    case 'status':
      return runMissionStatus(mode, rest);
    case 'stop':
      return runMissionStop(mode, rest);
    case 'wait':
      return runMissionWait(mode, rest);
    case 'tail':
      return runMissionTail(mode, rest);
    default:
      throw new CliError(
        'unknown_mission_subcommand',
        `Unknown mission subcommand: ${secondary ?? '(none)'}`,
        EXIT.INVALID_ARGS,
        'Subcommands: create | dispatch | status | stop | wait | tail. Run `o8 --help`.',
      );
  }
}
