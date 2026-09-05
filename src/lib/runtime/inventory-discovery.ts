import type { AgentRuntime, RuntimeSession } from '@/lib/runtimes/types';

const RUNTIME_DISCOVERY_CONCURRENCY = 2;

export async function discoverRuntimeSessions(
  runtimes: AgentRuntime[],
  options: { fresh: boolean },
): Promise<Array<PromiseSettledResult<{ runtime: AgentRuntime; sessions: RuntimeSession[] }>>> {
  const results = new Array<PromiseSettledResult<{ runtime: AgentRuntime; sessions: RuntimeSession[] }>>(runtimes.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(RUNTIME_DISCOVERY_CONCURRENCY, runtimes.length) },
    async () => {
      while (nextIndex < runtimes.length) {
        const index = nextIndex;
        nextIndex += 1;
        const runtime = runtimes[index];
        try {
          results[index] = {
            status: 'fulfilled',
            value: {
              runtime,
              sessions: await runtime.discoverSessions({ fresh: options.fresh }),
            },
          };
        } catch (reason) {
          results[index] = { status: 'rejected', reason };
        }
      }
    },
  );
  await Promise.all(workers);
  return results;
}
