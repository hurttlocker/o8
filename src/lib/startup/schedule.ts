import { getApiBase } from '@/lib/panel/api-port';
import { getOrCreateWsToken } from '@/lib/ws-auth';

const runtime = globalThis as typeof globalThis & { __o8NextStartupScheduled?: boolean };

/** Cross the route boundary only after this server has served a complete health response. */
export function scheduleNextServerStartup(): void {
  if (runtime.__o8NextStartupScheduled) return;
  runtime.__o8NextStartupScheduled = true;

  const attempt = async () => {
    try {
      const origin = getApiBase();
      const health = await fetch(`${origin}/api/panel/status`, { signal: AbortSignal.timeout(1_500) });
      if (!health.ok || (await health.json()).product !== 'o8') throw new Error('not ready');
      const response = await fetch(`${origin}/api/review/auto-review`, {
        method: 'POST',
        headers: { authorization: `Bearer ${getOrCreateWsToken()}`, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'bootstrap' }),
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) {
        await response.arrayBuffer();
        return;
      }
    } catch {
      // The listener or its lazy route may still be starting. Retry locally;
      // never let optional boot work reject the instrumentation hook.
    }
    setTimeout(() => { void attempt(); }, 1_000).unref?.();
  };
  setTimeout(() => { void attempt(); }, 0).unref?.();
}
