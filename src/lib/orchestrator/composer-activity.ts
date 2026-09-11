import { packetTerminalState } from './packet-state';
import type { OrchestratorPacket, OrchestratorPacketStatus } from './types';

/**
 * Packet states a worker occupies while its dispatch is still in flight. The
 * composer counter reads off this set so the number under the composer is the
 * number of live workers the operator can count on screen — `awaiting_review`
 * and the terminal states are dispatched work that has stopped running, and the
 * crew card already carries those with their own vocabulary (#2148).
 */
const ACTIVE_WORKER_STATUSES: ReadonlySet<OrchestratorPacketStatus> = new Set([
  'queued',
  'launching',
  'running',
  'recovering',
]);

export type ComposerActivityPacket = Pick<OrchestratorPacket, 'status' | 'releaseState' | 'archivedAt'>;

export interface ComposerActivity {
  /** Tool calls the orchestrator's OWN turn currently has in flight. */
  orchestratorToolCount: number;
  /** Worker packets this thread dispatched that are still running. */
  workerCount: number;
  /** True when either side has work in flight — what keeps the bar on screen. */
  hasActivity: boolean;
}

export function isActiveWorkerPacket(packet: ComposerActivityPacket): boolean {
  return packetTerminalState(packet) === null && ACTIVE_WORKER_STATUSES.has(packet.status);
}

/**
 * Split what the composer status bar is measuring into two discrete counts.
 *
 * The bar used to render a single `N running` off the orchestrator's running
 * tool calls. `cortex_launch_agent` returns as soon as the lane is launched, so
 * a Multitask dispatch drove that count to zero at the exact moment the workers
 * started — the surface went idle while three workers were on screen (#2148).
 */
export function summarizeComposerActivity(input: {
  runningToolCount: number;
  packets: readonly ComposerActivityPacket[];
}): ComposerActivity {
  const orchestratorToolCount = Math.max(0, input.runningToolCount);
  const workerCount = input.packets.filter(isActiveWorkerPacket).length;
  return {
    orchestratorToolCount,
    workerCount,
    hasActivity: orchestratorToolCount > 0 || workerCount > 0,
  };
}

/** Plain-language count, e.g. `3 workers` / `1 tool`. */
export function pluralizeActivity(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
