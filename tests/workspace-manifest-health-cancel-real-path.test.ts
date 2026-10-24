import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'o8-manifest-health-')));
const previousDataDir = process.env.CORTEX_IDE_DATA_DIR;
const previousO8DataDir = process.env.O8_DATA_DIR;

beforeAll(async () => {
  process.env.CORTEX_IDE_DATA_DIR = path.join(root, 'data');
  process.env.O8_DATA_DIR = path.join(root, 'data');
  const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
  await updateOperatorDefaults({ productTelemetryEnabled: false, workspaceManifestPolicy: 'auto' });
});

afterAll(async () => {
  const { closeDb } = await import('@/lib/db');
  closeDb();
  if (previousDataDir === undefined) delete process.env.CORTEX_IDE_DATA_DIR;
  else process.env.CORTEX_IDE_DATA_DIR = previousDataDir;
  if (previousO8DataDir === undefined) delete process.env.O8_DATA_DIR;
  else process.env.O8_DATA_DIR = previousO8DataDir;
  rmSync(root, { recursive: true, force: true });
});

describe.sequential('workspace manifest HTTP health cancellation real path', () => {
  it.each(['healthy', 'failed', 'cancelled'] as const)('persists %s health through manifest apply', async (mode) => {
    let requestArrived = false;
    let responseClosed = false;
    let pendingResponse: ServerResponse | undefined;
    const server = createServer((_request, response) => {
      requestArrived = true;
      response.once('close', () => { responseClosed = true; });
      if (mode === 'cancelled') { pendingResponse = response; return; }
      response.writeHead(mode === 'healthy' ? 200 : 503);
      response.end('fixture health');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const url = `http://127.0.0.1:${port}/health`;
    const repoPath = path.join(root, mode);
    mkdirSync(repoPath);
    execFileSync('git', ['init', '-q', '-b', 'main', repoPath]);
    writeFileSync(path.join(repoPath, 'o8.workspace.json'), JSON.stringify({
      version: 1,
      services: [{ name: 'web', command: 'fixture-web', port: { preferred: port },
        health: { http: url, timeoutMs: 30_000 } }],
      preview: { url },
    }));
    execFileSync('git', ['add', 'o8.workspace.json'], { cwd: repoPath });
    execFileSync('git', ['-c', 'user.name=o8-test', '-c', 'user.email=test@o8.test',
      'commit', '-qm', 'fixture'], { cwd: repoPath });
    const { createLane, getLaneEvents, setLaneStatus, updateLane } = await import('@/lib/lane/registry');
    const { applyWorkspaceManifest } = await import('@/lib/workspace/manifest/apply');
    const { readWorkspaceManifestReceipt, settleTerminalWorkspaceManifest } = await import('@/lib/workspace/manifest/lifecycle');
    const { readWorkspacePortLeases } = await import('@/lib/workspace/manifest/port-leases');
    const packetId = `packet-health-${mode}`;
    const lane = createLane({ repoPath, branch: 'main', baseBranch: 'main', runtime: 'codex', label: packetId, packetId });
    updateLane(lane.id, { worktreePath: repoPath }, 'system');
    setLaneStatus(lane.id, 'launching', 'system', 'fixture launch');
    const application = applyWorkspaceManifest({ repoPath, worktreePath: repoPath, packetId, laneId: lane.id });
    try {
      await vi.waitFor(() => expect(requestArrived).toBe(true));
      if (mode === 'cancelled') {
        setLaneStatus(lane.id, 'failed', 'system', 'cancel pending health check');
        await vi.waitFor(() => expect(responseClosed).toBe(true), { timeout: 2_000 });
      }
      const result = await application;
      const receipt = await readWorkspaceManifestReceipt(repoPath);
      const events = getLaneEvents(lane.id, 100);
      expect(receipt).toMatchObject({ packetId, laneId: lane.id,
        state: mode === 'healthy' ? 'completed' : mode, finishedAt: expect.any(String) });
      if (mode === 'healthy') {
        expect(result?.preview).toBe(url);
        expect(receipt?.services[0].health).toMatchObject({ kind: 'http', ok: true });
        expect(events.filter(event => event.verb === 'workspace_manifest_failed')).toEqual([]);
      } else {
        expect(result).toBeNull();
        expect(events.filter(event => event.verb === 'workspace_manifest_applied')).toEqual([]);
        expect(events.filter(event => event.verb === 'workspace_manifest_failed')).toEqual([
          expect.objectContaining({ payload: expect.objectContaining({ state: mode, step: 'services' }) }),
        ]);
        if (mode === 'failed') expect(receipt?.services[0].health).toMatchObject({ ok: false, error: 'HTTP health probe returned 503.' });
        else {
          expect(receipt?.services).toEqual([]);
          expect(Object.values(await readWorkspacePortLeases()).some(lease => lease.laneId === lane.id)).toBe(false);
        }
      }
    } finally {
      pendingResponse?.end('fixture cleanup');
      server.closeAllConnections();
      await application;
      await settleTerminalWorkspaceManifest({ worktreePath: repoPath, packetId, laneId: lane.id });
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);
});
