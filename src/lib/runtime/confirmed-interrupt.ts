import { escalateInterrupt } from '@/lib/runtime/interrupt-escalation';
import type { AgentRuntime } from '@/lib/runtimes/types';

/** Convert a runtime's signal request into a verified process-exit receipt. */
export async function confirmDiscoveredInterrupt(
  runtime: Pick<AgentRuntime, 'interrupt'>,
  sessionKey: string,
) {
  const requested = await runtime.interrupt(sessionKey);
  if (!requested.ok) return { confirmed: false, note: requested.note };
  const pids = [...new Set((requested.pids ?? []).filter((pid) => Number.isInteger(pid) && pid > 0))];
  if (pids.length === 0) {
    return {
      confirmed: false,
      note: `${requested.note} Process exit could not be confirmed because the runtime returned no pid evidence.`,
    };
  }
  const results = [];
  for (const pid of pids) results.push(await escalateInterrupt({ pid }));
  const confirmed = results.every((result) => result.confirmedDead);
  return {
    confirmed,
    note: confirmed
      ? results.map((result) => result.note).join(' ')
      : `Process exit could not be confirmed. ${results.map((result) => result.note).join(' ')}`,
  };
}
