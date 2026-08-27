import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-terminal-persistence-health-'));
const priorO8DataDir = process.env.O8_DATA_DIR;
const priorCortexDataDir = process.env.CORTEX_IDE_DATA_DIR;
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const {
  currentPersistentTerminalHealth,
  readPersistentTerminalHealth,
  recordPersistentTerminalHealth,
} = await import('./persistence-health');

afterAll(() => {
  if (priorO8DataDir === undefined) delete process.env.O8_DATA_DIR;
  else process.env.O8_DATA_DIR = priorO8DataDir;
  if (priorCortexDataDir === undefined) delete process.env.CORTEX_IDE_DATA_DIR;
  else process.env.CORTEX_IDE_DATA_DIR = priorCortexDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('persistent terminal health receipt', () => {
  it('starts honest when the feature is enabled but no real shell has run', () => {
    expect(currentPersistentTerminalHealth(true)).toMatchObject({
      status: 'unverified',
      reason: 'no_runtime_receipt',
    });
  });

  it('persists a redacted degraded receipt with owner-only permissions', () => {
    recordPersistentTerminalHealth('degraded', 'tmux_unavailable');

    expect(readPersistentTerminalHealth()).toMatchObject({
      status: 'degraded',
      reason: 'tmux_unavailable',
    });
    const receiptPath = path.join(dataDir, 'persistent-terminal-health.json');
    expect(readFileSync(receiptPath, 'utf8')).not.toContain('token');
    expect(statSync(receiptPath).mode & 0o777).toBe(0o600);
  });

  it('reports an intentional opt-out instead of a failure', () => {
    expect(currentPersistentTerminalHealth(false)).toMatchObject({
      status: 'disabled',
      reason: 'operator_disabled',
    });
  });
});
