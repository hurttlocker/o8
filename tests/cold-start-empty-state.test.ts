import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

const priorO8DataDir = process.env.O8_DATA_DIR;
const priorCortexDataDir = process.env.CORTEX_IDE_DATA_DIR;
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-cold-start-empty-'));

delete process.env.O8_DATA_DIR;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const setupRoute = await import('@/app/api/setup/config/route');
const { getDataDir } = await import('@/lib/data-dir-migration');
const { getProjectsLedger } = await import('@/lib/repos/projects');
const { listRepos } = await import('@/lib/repos/registry');
const { ORCHESTRATOR_HISTORY_DIR } = await import('@/lib/mobile/orchestrator-thread-history');

afterAll(() => {
  if (priorO8DataDir === undefined) delete process.env.O8_DATA_DIR;
  else process.env.O8_DATA_DIR = priorO8DataDir;
  if (priorCortexDataDir === undefined) delete process.env.CORTEX_IDE_DATA_DIR;
  else process.env.CORTEX_IDE_DATA_DIR = priorCortexDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('cold start with only CORTEX_IDE_DATA_DIR configured', () => {
  it('boots setup, repo, project, and transcript state inside the empty data directory', async () => {
    expect(getDataDir()).toBe(dataDir);

    const configResponse = await setupRoute.GET();
    await expect(configResponse.json()).resolves.toEqual({
      setupComplete: false,
      skippedSteps: [],
    });
    await expect(listRepos()).resolves.toEqual([]);

    const projects = await getProjectsLedger();
    expect(projects.projects).toHaveLength(1);
    expect(projects.projects[0]).toMatchObject({
      id: 'default',
      name: 'Workspace',
      repoPaths: [],
    });
    expect(ORCHESTRATOR_HISTORY_DIR).toBe(path.join(dataDir, 'chat-history'));
    expect(existsSync(path.join(dataDir, 'projects.json'))).toBe(true);
    expect(existsSync(path.join(dataDir, 'cortex-ide.db'))).toBe(true);
  });

  it('persists first-run setup state in the isolated directory', async () => {
    const response = await setupRoute.POST(new NextRequest('http://127.0.0.1/api/setup/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skippedSteps: ['runtime'] }),
    }));

    expect(response.status).toBe(200);
    const persisted = JSON.parse(readFileSync(path.join(dataDir, 'setup.json'), 'utf8')) as {
      skippedSteps?: string[];
    };
    expect(persisted.skippedSteps).toEqual(['runtime']);
  });
});
