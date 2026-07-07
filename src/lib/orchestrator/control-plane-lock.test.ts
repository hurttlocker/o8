import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

process.env.CORTEX_IDE_DATA_DIR = mkdtempSync(join(tmpdir(), 'o8-control-plane-lock-'));
process.env.O8_DATA_DIR = process.env.CORTEX_IDE_DATA_DIR;

const { withControlPlaneLock } = await import('@/lib/orchestrator/control-plane');

const LOCK_DIR = join(process.env.CORTEX_IDE_DATA_DIR, 'orchestrator-state.json.lock');

describe('control-plane cross-process lock (#1488)', () => {
  it('holds the FS lock dir while the callback runs and releases it after', async () => {
    let sawLockDuring = false;
    await withControlPlaneLock(async () => {
      sawLockDuring = existsSync(LOCK_DIR);
    });
    expect(sawLockDuring).toBe(true);
    expect(existsSync(LOCK_DIR)).toBe(false);
  });

  it('serializes concurrent lock holders — no interleaving', async () => {
    const order: string[] = [];
    const first = withControlPlaneLock(async () => {
      order.push('a-start');
      await new Promise((resolve) => setTimeout(resolve, 50));
      order.push('a-end');
    });
    const second = withControlPlaneLock(async () => {
      order.push('b-start');
      order.push('b-end');
    });
    await Promise.all([first, second]);
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });

  it('breaks a stale lock left by a crashed holder instead of wedging', async () => {
    mkdirSync(LOCK_DIR, { recursive: true });
    writeFileSync(
      join(LOCK_DIR, 'holder.json'),
      JSON.stringify({ pid: 999999, at: Date.now() - 60_000 }),
      'utf8',
    );
    let ran = false;
    await withControlPlaneLock(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(existsSync(LOCK_DIR)).toBe(false);
  });
});
