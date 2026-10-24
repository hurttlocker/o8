import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { cutoverClient, cutoverHealth, publishCutoverMutation } from '../../tests/fixtures/ws-cutover-client';
import { startParityReference } from '../../tests/fixtures/ws-parity-server';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let phase = 'startup';
const percentile = (samples: number[], fraction: number) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return Number(sorted[Math.ceil(sorted.length * fraction) - 1].toFixed(3));
};
function rss(pid: number) {
  return Number(readFileSync(`/proc/${pid}/status`, 'utf8').match(/^VmRSS:\s+(\d+)/m)?.[1]) / 1024;
}

async function main() {
  if (process.platform !== 'linux' || !process.env.O8D_TEST_BINARY) throw new Error('Linux and compiled fixture binary required');
  const results = [];
  for (const enabled of [false, true]) {
    for (const count of [1, 20]) {
      phase = `${enabled ? 'on' : 'off'}/${count}/startup`;
      const server = await startParityReference({ o8d: enabled, stallFixture: true, logLimit: 400 });
      const clients: Awaited<ReturnType<typeof cutoverClient>>[] = [];
      try {
        clients.push(...await Promise.all(Array.from({ length: count }, () => cutoverClient(server.url, server.token))));
        const health = await cutoverHealth(server);
        if (enabled && health.delivery?.transport !== 'o8d') throw new Error('cutover not active');
        const memory = () => ({ tsMiB: Number(rss(server.pid).toFixed(2)),
          rustMiB: enabled ? Number(rss(health.delivery!.pid!).toFixed(2)) : 0 });
        const idle = memory();
        const fanout = [];
        for (let index = 0; index < 220; index += 1) {
          phase = `${enabled ? 'on' : 'off'}/${count}/fanout-${index}`;
          const id = `bench-${index}`;
          const start = performance.now();
          const published = publishCutoverMutation(server, id);
          await Promise.all(clients.map((client) => client.delivered(id)));
          const elapsed = performance.now() - start;
          await published;
          if (index >= 20) fanout.push(elapsed);
        }
        // Ping timestamps are recorded outside the stalled process. All samples
        // are retained, including requests queued during each synchronous burst.
        const latencies: number[] = [];
        const pending: (number | null)[] = clients.map(() => null);
        clients.forEach((client, index) => client.socket.on('message', (raw) => {
          if (JSON.parse(String(raw)).channel !== 'pong') return;
          const start = pending[index];
          pending[index] = null;
          if (start !== null) latencies.push(performance.now() - start);
        }));
        const timer = setInterval(() => clients.forEach((client, index) => {
          if (pending[index] !== null) return;
          pending[index] = performance.now();
          client.socket.send(JSON.stringify({ type: 'ping' }));
        }), 10);
        let peakMiB = 0;
        try {
          for (let index = 0; index < 10; index += 1) {
            phase = `${enabled ? 'on' : 'off'}/${count}/burst-${index}`;
            process.kill(server.pid, 'SIGUSR2');
            await delay(350);
            const current = memory();
            peakMiB = Math.max(peakMiB, current.tsMiB + current.rustMiB);
          }
          await delay(100);
        } finally { clearInterval(timer); }
        const drainDeadline = performance.now() + 1_000;
        while (pending.some((start) => start !== null) && performance.now() < drainDeadline) await delay(10);
        if (pending.some((start) => start !== null)) throw new Error('heartbeat sample missing');
        const loaded = memory();
        results.push({ flag: enabled ? 'on' : 'off', clients: count, fanoutSamples: fanout.length,
          fanoutP50Ms: percentile(fanout, 0.5), fanoutP95Ms: percentile(fanout, 0.95),
          stallSamples: latencies.length, stallP95Ms: percentile(latencies, 0.95), stallMaxMs: percentile(latencies, 1),
          idle, loaded, peakSampledTotalMiB: Number(peakMiB.toFixed(2)) });
      } finally {
        await Promise.all(clients.map((client) => client.close()));
        await server.stop();
      }
    }
  }
  console.log(JSON.stringify({ method: 'Same authenticated TS HTTP producer and app URL, 1 KiB mutations, 20 warmups + 200 samples to last client receipt. 10 fixture-only 300 ms large-state JSON bursts, application pings every 10 ms from a separate process with one outstanding ping per client. Linux TS + Rust RSS; peak sampled after each burst, not allocator peak. Isolated fixtures; no desktop or accounts.', results }, null, 2));
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : '';
  const safe = /^(cutover (not active|client timed out|producer rejected)|heartbeat sample missing|reference WS (health timed out|process exited))$/.test(message);
  console.error(`Cutover benchmark failed at ${phase}: ${safe ? message : 'fixture or delivery error'}`);
  process.exitCode = 1;
});
