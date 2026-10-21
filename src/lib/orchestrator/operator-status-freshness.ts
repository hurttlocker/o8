import { stat } from 'node:fs/promises';
import type { Lane } from '@/lib/lane/types';
import { probeOwnedSessionLiveness } from '@/lib/lane/owned-session-liveness';
import { getAllRuntimes } from '@/lib/runtimes';
import { readOwnedSessionRecord } from '@/lib/runtimes/shared/owned-session-index';
import { probeOwnedRunMarker } from '@/lib/runtimes/shared/owned-session/run-process-proof';
import type { OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session/types';
import type { OperatorStatusAgent } from './operator-status-model';
import { statusAgeLabel } from './status-age';

export const RUNNING_SESSION_STALE_MS = 30 * 60_000;

function processExists(pid: number | undefined): boolean | undefined {
  if (!Number.isSafeInteger(pid) || !pid) return undefined;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ESRCH' ? false : code === 'EPERM' ? true : undefined;
  }
}

async function sessionProcessAlive(record: OwnedSessionRecord & { rpcPid?: number }, lane?: Lane) {
  const run = record.activeRun;
  const pids = [run?.pid, record.rpcPid].filter((pid): pid is number => (
    typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0
  ));
  if (run?.processGroupId && process.platform !== 'win32') pids.push(-run.processGroupId);
  const probes = pids.map(processExists);
  if (probes.includes(true)) return true;
  if (probes.includes(undefined)) return undefined;
  if (run?.processMarker) {
    const marker = await probeOwnedRunMarker(run.processMarker);
    if (marker !== 'clear') return marker === 'live' ? true : undefined;
  }
  if (run && probes.length === 0 && !run.tmuxSession && !run.processMarker) return undefined;
  const owned = await probeOwnedSessionLiveness(record.surfaceId, lane?.worktreePath ?? record.cwd);
  // The bridge helper also returns false when its server is unreachable. With
  // a tmux identity, only a positive result is conclusive for status polling.
  if (run?.tmuxSession) return owned.alive === true ? true : undefined;
  if (owned.alive !== undefined) return owned.alive;
  // The worktree continuity probe owns codex wrapper-PID uncertainty. Other
  // PID-only stores can retain activeRun after the server and worker exit.
  if (!record.surfaceId.startsWith('codex-owned:') && !run?.tmuxSession && probes.length > 0) return false;
  return undefined;
}

/** Observational overlay only: status polling never repairs session records. */
export async function applyOperatorStatusFreshness(agents: OperatorStatusAgent[], lanes: Lane[]) {
  const laneBySession = new Map(lanes.map((lane) => [lane.sessionKey, lane]));
  return Promise.all(agents.map(async (agent) => {
    if (agent.status !== 'running' && agent.status !== 'working') return agent;
    const observedMs = Date.parse(agent.observedAt);
    if (!Number.isFinite(observedMs) || Date.now() - observedMs < RUNNING_SESSION_STALE_MS) return agent;
    try {
      const record = await readOwnedSessionRecord(agent.sessionKey);
      if (!record) return agent; // Missing/unreadable/unsupported metadata is unknown.
      // Metadata updatedAt can advance when transcript readback saves a session;
      // only runtime activity may renew a running claim.
      let lastEventMs = Math.max(observedMs, ...[record.activeRun?.startedAt]
        .map((value) => Date.parse(value ?? '')).filter(Number.isFinite));
      if (record.activeRun?.stdoutPath) {
        try {
          const log = await stat(record.activeRun.stdoutPath);
          if (log.size > 0) lastEventMs = Math.max(lastEventMs, log.mtimeMs);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return agent;
        }
      }
      const ageMs = Math.max(0, Date.now() - lastEventMs);
      if (ageMs < RUNNING_SESSION_STALE_MS) return agent;
      const alive = await sessionProcessAlive(record, laneBySession.get(agent.sessionKey));
      if (alive !== false) return agent;
      const summary = `Stale session: no live process; last runtime activity ${statusAgeLabel(ageMs)} ago.`;
      const canResume = getAllRuntimes().find((runtime) => runtime.id === agent.runtime)?.capabilities.resume;
      return {
        ...agent,
        status: 'stale',
        summary,
        observedAt: new Date(lastEventMs).toISOString(),
        freshness: { ageMs, thresholdMs: RUNNING_SESSION_STALE_MS, processAlive: false },
        statusEvidence: {
          ...agent.statusEvidence,
          state: 'unknown' as const,
          observedAt: new Date(lastEventMs).toISOString(),
          summary,
          fallbackReason: 'Stored running status is stale and the owned process probe found no live process.',
          evidence: [...agent.statusEvidence.evidence, { source: 'owned-session.process', value: 'not-live' }],
        },
        nextActions: canResume ? [{
          label: 'Recover session', endpoint: '/api/runtime/action', method: 'POST',
          action: 'steer', surfaceId: agent.sessionKey, requiredInputs: ['message', 'clientMutationId'],
        }] : [],
      };
    } catch {
      return agent; // Failed process/metadata probes do not establish death.
    }
  }));
}
