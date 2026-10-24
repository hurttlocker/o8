import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, Socket, type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const network = vi.hoisted(() => ({ socket: null as import('node:net').Socket | null }));
vi.mock('node:net', async original => {
  const actual = await original<typeof import('node:net')>();
  return { ...actual, connect: (...args: unknown[]) => network.socket ?? Reflect.apply(actual.connect, actual, args) };
});

const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'o8-manifest-tcp-')));
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

// Control connection completion at the network boundary. Manifest application,
// Git, SQLite, lane cancellation and lease cleanup use their production paths.
describe.sequential('workspace manifest TCP health lifecycle', () => {
  it.each(['healthy', 'failed', 'cancelled'] as const)('settles %s TCP health through manifest apply', async mode => {
    const listener = createServer();
    await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
    const preferred = (listener.address() as AddressInfo).port;
    await new Promise<void>(resolve => listener.close(() => resolve()));
    const repoPath = path.join(root, mode);
    mkdirSync(repoPath);
    execFileSync('git', ['init', '-q', '-b', 'main', repoPath]);
    writeFileSync(path.join(repoPath, 'o8.workspace.json'), JSON.stringify({
      version: 1,
      services: [{ name: 'db', command: 'fixture-db', port: { preferred }, health: { tcp: true, timeoutMs: 30_000 } }],
      preview: { url: 'http://127.0.0.1:{{port}}/' },
    }));
    execFileSync('git', ['add', 'o8.workspace.json'], { cwd: repoPath });
    execFileSync('git', ['-c', 'user.name=o8-test', '-c', 'user.email=test@o8.test',
      'commit', '-qm', 'fixture'], { cwd: repoPath });
    const { createLane, getLaneEvents, setLaneStatus, updateLane } = await import('@/lib/lane/registry');
    const { applyWorkspaceManifest } = await import('@/lib/workspace/manifest/apply');
    const { readWorkspaceManifestReceipt, settleTerminalWorkspaceManifest } = await import('@/lib/workspace/manifest/lifecycle');
    const { readWorkspacePortLeases } = await import('@/lib/workspace/manifest/port-leases');
    const packetId = `packet-tcp-${mode}`;
    const lane = createLane({ repoPath, branch: 'main', baseBranch: 'main', runtime: 'codex', label: packetId, packetId });
    updateLane(lane.id, { worktreePath: repoPath }, 'system');
    setLaneStatus(lane.id, 'launching', 'system', 'fixture launch');
    const socket = new Socket();
    network.socket = socket;
    const application = applyWorkspaceManifest({ repoPath, worktreePath: repoPath, packetId, laneId: lane.id });
    let settled = false;
    void application.then(() => { settled = true; });
    try {
      await vi.waitFor(() => expect(socket.listenerCount('connect')).toBeGreaterThan(0));
      expect(socket.destroyed).toBe(false);
      if (mode === 'healthy') socket.emit('connect');
      else if (mode === 'failed') socket.emit('error', new Error('Fixture TCP refusal.'));
      else setLaneStatus(lane.id, 'failed', 'system', 'cancel pending TCP health');
      await vi.waitFor(() => {
        expect(socket.destroyed).toBe(true);
        expect(settled).toBe(true);
      }, { timeout: 1_000 });
      const result = await application;
      const receipt = await readWorkspaceManifestReceipt(repoPath);
      const events = getLaneEvents(lane.id, 100);
      expect(receipt).toMatchObject({ packetId, laneId: lane.id,
        state: mode === 'healthy' ? 'completed' : mode, finishedAt: expect.any(String) });
      if (mode === 'healthy') {
        expect(receipt?.services[0].health).toMatchObject({ kind: 'tcp', ok: true });
        expect(result?.preview).toBe(`http://127.0.0.1:${receipt?.ports.db}/`);
      } else {
        expect(result).toBeNull();
        expect(events.some(event => event.verb === 'workspace_manifest_applied')).toBe(false);
        expect(events.filter(event => event.verb === 'workspace_manifest_failed')).toEqual([
          expect.objectContaining({ payload: expect.objectContaining({ state: mode, step: 'services' }) }),
        ]);
        if (mode === 'failed') expect(receipt?.services[0].health).toMatchObject({ kind: 'tcp', ok: false, error: 'Fixture TCP refusal.' });
        else {
          expect(receipt?.services).toEqual([]);
          expect(Object.values(await readWorkspacePortLeases()).some(lease => lease.laneId === lane.id)).toBe(false);
        }
      }
    } finally {
      if (!socket.destroyed && socket.listenerCount('error') > 0) socket.emit('error', new Error('Fixture cleanup.'));
      socket.destroy();
      await application;
      network.socket = null;
      await settleTerminalWorkspaceManifest({ worktreePath: repoPath, packetId, laneId: lane.id });
    }
  }, 30_000);
});
