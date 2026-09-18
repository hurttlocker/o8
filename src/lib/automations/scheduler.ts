/** Durable automation scheduler backed by per-fire SQLite leases. */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { getDataDir } from '@/lib/data-dir-migration';
import {
  claimNextAutomationFire,
  materializeDueAutomationFires,
  type AutomationFire,
} from './fire-store';
import { runClaimedAutomationFire } from './fire-runner';
import { materializeWatchAutomationFires } from './watch-store';
import { drainParkedSymonWatches, expireSymonWatches } from './symon-watch';
import { evaluateFuzzyWatches } from './fuzzy-watch';

const TICK_MS = 30_000;
const DEFAULT_LEASE_MS = 60 * 60 * 1000;
const DEFAULT_CONCURRENCY_CAP = 4;
const HEARTBEAT_PATH = path.join(getDataDir(), 'automations-scheduler.heartbeat');
const SCHEDULER_WORKER_ID = `scheduler:${process.env.O8_BOOT_ID?.trim() || process.pid}:${randomUUID()}`;

let started = false;
let bootedAt = 0;

function positiveEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function writeHeartbeat(nowMs: number, summary: Record<string, unknown> = {}): void {
  try {
    writeFileSync(HEARTBEAT_PATH, `${JSON.stringify({
      lastTickAt: nowMs,
      bootedAt,
      tickIntervalMs: TICK_MS,
      concurrencyCap: positiveEnv('O8_AUTOMATION_CONCURRENCY', DEFAULT_CONCURRENCY_CAP),
      ...summary,
    })}\n`);
  } catch {
    // Diagnostic only; durable fire state remains authoritative.
  }
}

export async function runAutomationSchedulerTick(input: {
  nowMs?: number;
  workerId?: string;
  concurrencyCap?: number;
  leaseMs?: number;
  maxClaims?: number;
} = {}): Promise<{ materialized: AutomationFire[]; completed: AutomationFire[] }> {
  const nowMs = input.nowMs ?? Date.now();
  const workerId = input.workerId ?? SCHEDULER_WORKER_ID;
  const concurrencyCap = Math.max(1, Math.floor(
    input.concurrencyCap ?? positiveEnv('O8_AUTOMATION_CONCURRENCY', DEFAULT_CONCURRENCY_CAP),
  ));
  const leaseMs = input.leaseMs ?? positiveEnv('O8_AUTOMATION_LEASE_MS', DEFAULT_LEASE_MS);
  const maxClaims = Math.max(concurrencyCap, Math.floor(input.maxClaims ?? concurrencyCap * 4));
  // Deadlines first, and only deadlines: the shared materializer also disables
  // an expired row, but only this pass can write the matching Symon ledger
  // entry. It touches no network, so running it first costs a tick nothing.
  let symonExpired: string[] = [];
  try {
    symonExpired = expireSymonWatches(nowMs);
  } catch (error) {
    console.warn('[automations-scheduler] Symon watch expiry failed:', error);
  }
  // Fuzzy watches (#2443) are asked beside the exact-watch pass. With the
  // judgment referee off this returns before any read, so the tick is unchanged.
  let fuzzyFires: AutomationFire[] = [];
  try {
    fuzzyFires = await evaluateFuzzyWatches(nowMs);
  } catch (error) {
    console.warn('[automations-scheduler] fuzzy watch evaluation failed:', error);
  }
  const materialized = [
    ...materializeDueAutomationFires(nowMs),
    ...materializeWatchAutomationFires(nowMs),
    ...fuzzyFires,
  ];
  const completed: AutomationFire[] = [];

  while (completed.length < maxClaims) {
    const wave: AutomationFire[] = [];
    while (wave.length < concurrencyCap && completed.length + wave.length < maxClaims) {
      const fire = claimNextAutomationFire({
        workerId,
        leaseMs,
        concurrencyCap,
        nowMs,
      });
      if (!fire) break;
      wave.push(fire);
    }
    if (wave.length === 0) break;
    const settled = await Promise.all(wave.map((fire) => (
      runClaimedAutomationFire(fire, input.nowMs == null ? Date.now : () => nowMs)
    )));
    completed.push(...settled.filter((fire): fire is AutomationFire => Boolean(fire)));
  }

  // Announcing parked watches makes bounded network calls, so it runs LAST and
  // inside its own guard: a failure here must never cost the ordinary
  // automations their tick.
  let symonDrained = 0;
  try {
    symonDrained = (await drainParkedSymonWatches(nowMs)).length;
  } catch (error) {
    console.warn('[automations-scheduler] Symon watch drain failed:', error);
  }

  writeHeartbeat(Date.now(), {
    materialized: materialized.length,
    completed: completed.length,
    symonWatchesExpired: symonExpired.length,
    symonWatchesDrained: symonDrained,
  });
  return { materialized, completed };
}

export function bootAutomationsScheduler(): void {
  if (started) return;
  started = true;
  if (process.env.O8_DISABLE_AUTOMATIONS === '1') {
    console.log('[automations-scheduler] disabled via O8_DISABLE_AUTOMATIONS=1');
    return;
  }
  bootedAt = Date.now();
  console.log(
    `[automations-scheduler] durable tick every ${TICK_MS / 1000}s · `
    + `concurrency ${positiveEnv('O8_AUTOMATION_CONCURRENCY', DEFAULT_CONCURRENCY_CAP)} · `
    + `heartbeat ${HEARTBEAT_PATH}`,
  );
  setTimeout(() => { void runAutomationSchedulerTick(); }, 2_000).unref();
  setInterval(() => { void runAutomationSchedulerTick(); }, TICK_MS).unref();
}
