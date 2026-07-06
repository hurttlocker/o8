import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveWorkerEffortDefault } from './worker-effort-default';

describe('resolveWorkerEffortDefault', () => {
  it('keeps runtime defaults when the operator setting is adaptive', () => {
    expect(resolveWorkerEffortDefault({
      runtime: 'codex',
      explicitEffort: undefined,
      codexWorkerEffort: 'adaptive',
      claudeWorkerEffort: 'adaptive',
    })).toBeUndefined();
  });

  it('uses the selected runtime default and lets explicit effort win', () => {
    expect(resolveWorkerEffortDefault({
      runtime: 'claude-code',
      explicitEffort: undefined,
      codexWorkerEffort: 'xhigh',
      claudeWorkerEffort: 'max',
    })).toBe('max');
    expect(resolveWorkerEffortDefault({
      runtime: 'claude-code',
      explicitEffort: 'high',
      codexWorkerEffort: 'xhigh',
      claudeWorkerEffort: 'max',
    })).toBe('high');
  });
});

describe('operator worker effort defaults persistence', () => {
  let dataDir: string;
  let previousDataDir: string | undefined;
  let previousCodexEnv: string | undefined;
  let previousClaudeEnv: string | undefined;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-worker-effort-defaults-'));
    previousDataDir = process.env.CORTEX_IDE_DATA_DIR;
    previousCodexEnv = process.env.O8_CODEX_WORKER_EFFORT;
    previousClaudeEnv = process.env.O8_CLAUDE_WORKER_EFFORT;
    process.env.CORTEX_IDE_DATA_DIR = dataDir;
    delete process.env.O8_CODEX_WORKER_EFFORT;
    delete process.env.O8_CLAUDE_WORKER_EFFORT;
  });

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env.CORTEX_IDE_DATA_DIR;
    else process.env.CORTEX_IDE_DATA_DIR = previousDataDir;
    if (previousCodexEnv === undefined) delete process.env.O8_CODEX_WORKER_EFFORT;
    else process.env.O8_CODEX_WORKER_EFFORT = previousCodexEnv;
    if (previousClaudeEnv === undefined) delete process.env.O8_CLAUDE_WORKER_EFFORT;
    else process.env.O8_CLAUDE_WORKER_EFFORT = previousClaudeEnv;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('round-trips codexWorkerEffort and claudeWorkerEffort through operator defaults', async () => {
    const { getOperatorDefaults, updateOperatorDefaults } = await import('./defaults');

    const initial = await getOperatorDefaults();
    expect(initial.values.codexWorkerEffort).toBe('adaptive');
    expect(initial.values.claudeWorkerEffort).toBe('adaptive');

    const updated = await updateOperatorDefaults({
      codexWorkerEffort: 'xhigh',
      claudeWorkerEffort: 'max',
    });
    expect(updated.values.codexWorkerEffort).toBe('xhigh');
    expect(updated.values.claudeWorkerEffort).toBe('max');

    const reloaded = await getOperatorDefaults();
    expect(reloaded.values.codexWorkerEffort).toBe('xhigh');
    expect(reloaded.values.claudeWorkerEffort).toBe('max');
    expect(reloaded.sources.codexWorkerEffort).toBe('file');
    expect(reloaded.sources.claudeWorkerEffort).toBe('file');
  });
});
