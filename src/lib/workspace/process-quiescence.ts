export type ProcessQuiescenceState = 'quiescent' | 'live' | 'unknown';
export type ProcessPrimitiveState = 'clear' | 'live' | 'unknown';

export type ProcessPrimitive =
  | 'pid'
  | 'process_group'
  | 'descendants'
  | 'owned_marker'
  | 'tmux'
  | 'runtime'
  | 'retained_run_ledger'
  | 'filesystem_users';

export interface ProcessProbeReceipt {
  primitive: ProcessPrimitive;
  state: ProcessPrimitiveState;
  detail: string;
  pids?: number[];
}

export interface ProcessIdentityReceipt {
  ownership: 'owned' | 'unowned' | 'unknown';
  pidIdentity: 'matched' | 'reused' | 'not_applicable' | 'unknown';
  sessionKey?: string;
  expectedPid?: number;
  expectedProcessGroupId?: number;
  expectedCommandIdentity?: string;
  retainedRuns?: Array<{
    runId: string;
    outcome: string;
    pid: number;
    pidIdentity: 'matched' | 'reused' | 'not_applicable' | 'unknown';
    processGroupId?: number;
    commandIdentity?: string;
    processMarker?: string;
    spawnState?: string;
    tmuxSession?: string;
  }>;
}

export interface ProcessQuiescenceReceipt {
  state: ProcessQuiescenceState;
  identity: ProcessIdentityReceipt;
  probes: ProcessProbeReceipt[];
  reasons: string[];
  checkedAt: string;
}

const REQUIRED_PRIMITIVES: readonly ProcessPrimitive[] = [
  'pid',
  'process_group',
  'descendants',
  'owned_marker',
  'tmux',
  'runtime',
  'retained_run_ledger',
  'filesystem_users',
];

function normalizePids(pids: number[] | undefined): number[] | undefined {
  if (!pids) return undefined;
  return [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))].sort((left, right) => left - right);
}

/**
 * Combine authoritative process probes without killing or stopping anything.
 * Positive liveness wins. Quiescence requires owned identity, no PID reuse,
 * and a clear receipt from every required primitive.
 */
export function synthesizeProcessQuiescence(
  identity: ProcessIdentityReceipt,
  probes: ProcessProbeReceipt[],
  now: () => Date = () => new Date(),
): ProcessQuiescenceReceipt {
  const normalized = probes.map((probe) => ({ ...probe, pids: normalizePids(probe.pids) }));
  const reasons: string[] = [];
  const byPrimitive = new Map<ProcessPrimitive, ProcessProbeReceipt[]>();
  for (const probe of normalized) {
    const existing = byPrimitive.get(probe.primitive);
    if (existing) existing.push(probe);
    else byPrimitive.set(probe.primitive, [probe]);
  }

  if (identity.ownership !== 'owned') {
    reasons.push(identity.ownership === 'unowned'
      ? 'Session is not owned by o8.'
      : 'Session ownership could not be proved.');
  }
  if (identity.pidIdentity === 'reused') reasons.push('The recorded PID belongs to a different process.');
  if (identity.pidIdentity === 'unknown') reasons.push('PID identity could not be proved.');

  for (const primitive of REQUIRED_PRIMITIVES) {
    const receipts = byPrimitive.get(primitive) ?? [];
    if (receipts.length !== 1) {
      reasons.push(receipts.length === 0
        ? `Missing ${primitive} probe.`
        : `Conflicting duplicate ${primitive} probes.`);
      continue;
    }
    if (receipts[0]?.state === 'unknown') reasons.push(`${primitive}: ${receipts[0].detail}`);
  }

  const hasLive = normalized.some((probe) => probe.state === 'live');
  const identityUnknown = identity.ownership !== 'owned'
    || identity.pidIdentity === 'reused'
    || identity.pidIdentity === 'unknown';
  const complete = REQUIRED_PRIMITIVES.every((primitive) => byPrimitive.get(primitive)?.length === 1);
  const allClear = complete && normalized.every((probe) => probe.state === 'clear');
  const state: ProcessQuiescenceState = identity.pidIdentity === 'reused'
    ? 'unknown'
    : hasLive
      ? 'live'
      : !identityUnknown && allClear
        ? 'quiescent'
        : 'unknown';

  return {
    state,
    identity,
    probes: normalized,
    reasons,
    checkedAt: now().toISOString(),
  };
}

export function processProbe(
  primitive: ProcessPrimitive,
  state: ProcessPrimitiveState,
  detail: string,
  pids?: number[],
): ProcessProbeReceipt {
  return { primitive, state, detail, pids: normalizePids(pids) };
}
