import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

it('releases transcript bodies after HTTP history reads and real ws-server sessions close', async () => {
  const evidence = process.env.O8_SESSION_MEMORY_EVIDENCE ?? mkdtempSync(join(tmpdir(), 'o8-session-memory-'));
  try {
    const modulePath = resolve('scripts/bench/session-memory.mjs');
    const { measureSessionMemory } = await import(/* @vite-ignore */ modulePath);
    const receipt = await measureSessionMemory({ output: evidence, sessions: 12, transcriptMiB: 4 });
    console.log(JSON.stringify(receipt));
    expect(receipt.completedSessions).toBe(12);
    expect(receipt.persistedOutputUnchanged).toBe(true);
    for (const name of ['next', 'ws'] as const) {
      expect.soft(receipt.after[name].heapUsedMiB, `${name} post-activity idle heap ceiling`).toBeLessThan(96);
      expect.soft(receipt.after[name].heapUsedMiB - receipt.idle[name].heapUsedMiB,
        `${name} post-activity retained heap growth ceiling`).toBeLessThan(24);
    }
  } finally {
    if (!process.env.O8_SESSION_MEMORY_EVIDENCE) rmSync(evidence, { recursive: true, force: true });
  }
}, 180_000);
