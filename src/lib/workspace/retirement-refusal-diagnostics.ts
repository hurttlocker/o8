import { createHash } from 'node:crypto';

import type { ProcessPrimitive, ProcessProbeReceipt, ProcessQuiescenceReceipt } from './process-quiescence';

const PHASE = 'retirement_process_refused';
const MAX_EVENTS_PER_LANE = 8;
const MAX_PAYLOAD_CHARACTERS = 1000;
const PRIMITIVES: ProcessPrimitive[] = [
  'pid', 'process_group', 'descendants', 'owned_marker', 'tmux', 'runtime', 'retained_run_ledger', 'filesystem_users',
];
const REASON_CODES = new Set([
  'pid_invalid', 'pid_unavailable', 'pid_unreadable', 'pid_reused', 'pid_legacy',
  'group_identity_missing', 'group_unavailable', 'descendants_unavailable',
  'descendants_depth_limit', 'marker_unavailable', 'marker_missing', 'tmux_unavailable',
  'runtime_unknown', 'ledger_incomplete', 'coverage_missing', 'permission_denied',
  'probe_timeout', 'probe_output_bound', 'probe_unavailable', 'probe_failed',
  'cwd_snapshot_failed', 'owned_process_live', 'detail_unrecognized', 'probe_missing', 'probe_conflict',
]);

/** Closed vocabulary only: never copy arbitrary stderr, markers, paths or commands. */
export function safeProcessProbeReasons(detail: string): string[] {
  const encoded = detail.split(';').filter((code) => REASON_CODES.has(code) || /^probe_exit_\d{1,3}$/.test(code));
  if (encoded.length) return [...new Set(encoded)].slice(0, 4);
  const fixed: Array<[RegExp, string]> = [
    [/no valid PID identity/, 'pid_invalid'], [/ps is unavailable/, 'pid_unavailable'],
    [/unreadable process identity/, 'pid_unreadable'], [/belongs to another command/, 'pid_reused'],
    [/predates durable command identity/, 'pid_legacy'], [/no durable process-group identity/, 'group_identity_missing'],
    [/pgrep is unavailable.*process group/, 'group_unavailable'],
    [/pgrep is unavailable.*descendants/, 'descendants_unavailable'],
    [/traversal exceeded its depth bound/, 'descendants_depth_limit'],
    [/cannot scan inherited owned-run markers/, 'marker_unavailable'],
    [/predates durable owned-run markers/, 'marker_missing'], [/tmux is unavailable/, 'tmux_unavailable'],
    [/runtime process identity is uncertain/, 'runtime_unknown'],
    [/ledger is legacy|does not contain a bounded retained-run ledger/, 'ledger_incomplete'],
    [/probe coverage is incomplete/, 'coverage_missing'],
    [/permission denied|EACCES|EPERM/i, 'permission_denied'],
    [/timed? ?out|timeout|ETIMEDOUT/i, 'probe_timeout'],
    [/maxBuffer|buffer.*exceed|ENOBUFS/i, 'probe_output_bound'],
    [/unavailable|ENOENT|not found/i, 'probe_unavailable'],
    [/still live|still have a cwd|still carries|process descendants are|process group is still|PID is still/, 'owned_process_live'],
  ];
  for (const [pattern, code] of fixed) if (pattern.test(detail)) return [code];
  const exit = /(?:failed with exit|exited) (\d{1,3})(?:\D|$)/.exec(detail);
  if (exit) return ['probe_exit_' + exit[1]];
  if (detail.startsWith('Machine cwd snapshot failed:')) return ['cwd_snapshot_failed'];
  return ['detail_unrecognized'];
}

export function summarizeProcessProbeDetails(probes: ProcessProbeReceipt[]): string {
  return [...new Set(probes.flatMap((probe) => safeProcessProbeReasons(probe.detail)))].slice(0, 4).join(';');
}

/** Only callers which have proved the exact lane/session/source may record this. */
export async function persistRetirementProcessRefusal(input: {
  laneId: string;
  repositoryUuid: string;
  packetId: string;
  sessionKey: string;
  sourceDevice: number;
  sourceInode: number;
  process: ProcessQuiescenceReceipt;
}): Promise<{ eventId: string; duplicate: boolean }> {
  const { process } = input;
  if (process.state === 'quiescent') throw new Error('Quiescence is not a refusal diagnostic.');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(process.checkedAt)) {
    throw new Error('Refusal diagnostic timestamp is invalid.');
  }
  const failed = PRIMITIVES.flatMap((primitive) => {
    const probes = process.probes.filter((probe) => probe.primitive === primitive);
    if (probes.length !== 1) return [[primitive, 'unknown', probes.length ? 'probe_conflict' : 'probe_missing']];
    const probe = probes[0]!;
    return probe.state === 'clear' ? [] : [[primitive, probe.state, safeProcessProbeReasons(probe.detail).slice(0, 2).join(';')]];
  });
  const generation = createHash('sha256').update(JSON.stringify([
    input.repositoryUuid, input.packetId, input.sessionKey, input.sourceDevice, input.sourceInode,
  ])).digest('hex').slice(0, 24);
  const signature = createHash('sha256').update(JSON.stringify([
    generation, process.state, process.identity.ownership, process.identity.pidIdentity, failed,
  ])).digest('hex').slice(0, 24);
  const payload = { phase: PHASE, version: 1, checkedAt: process.checkedAt, state: process.state,
    ownership: process.identity.ownership, pidIdentity: process.identity.pidIdentity, generation, signature, failed };
  if (JSON.stringify(payload).length > MAX_PAYLOAD_CHARACTERS) throw new Error('Refusal diagnostic exceeds its size bound.');
  // Lazy imports keep pure probe summarization independent of the event store.
  const { getSqlite } = await import('@/lib/db');
  const { appendEvent } = await import('@/lib/lane/registry');
  return getSqlite().transaction(() => {
    const existing = getSqlite().prepare(`SELECT id, payload_json FROM lane_events
      WHERE lane_id = ? AND verb = 'update' AND json_extract(payload_json, '$.phase') = ?
      ORDER BY timestamp ASC LIMIT ?`).all(input.laneId, PHASE, MAX_EVENTS_PER_LANE + 1) as Array<{
        id: string; payload_json: string;
      }>;
    for (const event of existing) {
      if ((JSON.parse(event.payload_json) as { signature?: unknown }).signature === signature) {
        return { eventId: event.id, duplicate: true };
      }
    }
    if (existing.length >= MAX_EVENTS_PER_LANE) throw new Error('Refusal diagnostic history reached its eight-event bound.');
    const event = appendEvent(input.laneId, 'update', 'system', payload);
    return { eventId: event.id, duplicate: false };
  }).immediate();
}
