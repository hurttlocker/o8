import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

const resolveCliMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/runtimes/shared/cli-resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runtimes/shared/cli-resolver')>();
  return {
    ...actual,
    resolveCli: resolveCliMock,
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: spawnMock,
  };
});

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-openclaw-preflight-'));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
const repoPath = path.join(dataDir, 'repo');
mkdirSync(repoPath, { recursive: true });
execFileSync('git', ['init', '-q', repoPath]);

const { CliNotFoundError } = await import('@/lib/runtimes/shared/cli-resolver');
const { openclawBackend } = await import('@/lib/lane/orchestrator-backends/openclaw');

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('OpenClaw orchestrator spawn preflight', () => {
  it('reports an install action before starting a gateway when the CLI is missing', async () => {
    resolveCliMock.mockRejectedValueOnce(
      new CliNotFoundError('openclaw', ['env:O8_OPENCLAW_BIN', 'which:openclaw']),
    );
    const events: Array<{ type: string; error?: string }> = [];

    await openclawBackend.sendTurn(repoPath, 'hello', (event) => events.push(event));

    const error = events.find((event) => event.type === 'error')?.error ?? '';
    expect(error).toContain('[runtime] OpenClaw is not installed');
    expect(error).toContain('O8_OPENCLAW_BIN');
    expect(error).not.toContain('ENOENT');
    expect(spawnMock).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === 'done')).toBe(true);
  });

  it('names a vanished repo before attempting CLI discovery', async () => {
    resolveCliMock.mockReset();
    const missingPath = path.join(dataDir, 'vanished-repo');
    const events: Array<{ type: string; error?: string }> = [];

    await openclawBackend.sendTurn(missingPath, 'hello', (event) => events.push(event));

    const error = events.find((event) => event.type === 'error')?.error ?? '';
    expect(error).toContain(missingPath);
    expect(error).toContain('no longer exists');
    expect(error).not.toContain('ENOENT');
    expect(resolveCliMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
