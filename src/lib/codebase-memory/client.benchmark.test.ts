import { describe, expect, it } from 'vitest';

import { extractGraphResolvedSymbols } from './client';

const benchmarkRepo = process.env.O8_SYMBOL_GRAPH_BENCH_REPO;
const iterations = Number(process.env.O8_SYMBOL_GRAPH_BENCH_ITERATIONS ?? '20');
const warmupIterations = 3;

const representativePacketBody = [
  '`traceSymbols`',
  '`buildContextBlock`',
  '`PacketCard`',
  '`extractGraphResolvedSymbols`',
  '`findSymbolDefinition`',
  '`callCodebaseMemoryTool`',
  '`missingAlpha`',
  '`missingBravo`',
  '`missingCharlie`',
  '`missingDelta`',
  '`missingEcho`',
  '`missingFoxtrot`',
  '`missingGolf`',
  '`missingHotel`',
  '`missingJuliet`',
].join(' ');

describe.skipIf(!benchmarkRepo)('symbol-graph latency benchmark', () => {
  it('reports the production call-site latency distribution', async () => {
    for (let index = 0; index < warmupIterations; index += 1) {
      await extractGraphResolvedSymbols(representativePacketBody, benchmarkRepo!, 3);
    }

    const samples: number[] = [];
    for (let index = 0; index < iterations; index += 1) {
      const started = performance.now();
      const result = await extractGraphResolvedSymbols(representativePacketBody, benchmarkRepo!, 3);
      samples.push(performance.now() - started);
      expect(result.unavailable).toBe(false);
      expect(result.edges.length).toBeGreaterThan(0);
    }

    const sorted = samples.toSorted((a, b) => a - b);
    const percentile = (value: number) => sorted[Math.ceil(value * sorted.length) - 1];
    console.info(JSON.stringify({
      callSite: 'recall.symbol-graph',
      samples: sorted.length,
      p50Ms: Number(percentile(0.5).toFixed(1)),
      p95Ms: Number(percentile(0.95).toFixed(1)),
      p99Ms: Number(percentile(0.99).toFixed(1)),
      maxMs: Number(sorted.at(-1)!.toFixed(1)),
    }));
  }, 300_000);
});
