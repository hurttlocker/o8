import type { ExecFileOptions } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type Socket } from 'node:net';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const setupInvocations = vi.hoisted(() => [] as Array<{
  cwd: string;
  env: NodeJS.ProcessEnv;
}>);
const healthConnections = vi.hoisted(() => [] as number[]);
const setupServers = vi.hoisted(() => [] as Server[]);
const setupSockets = vi.hoisted(() => [] as Socket[]);

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const execFile = (
    file: string,
    args: string[] = [],
    options: ExecFileOptions = {},
    callback?: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    if (!args.includes('prepare-workspace')) {
      return actual.execFile(file, args, options, callback as never);
    }
    const cwd = String(options.cwd);
    const env = options.env ?? process.env;
    setupInvocations.push({ cwd, env });
    const healthPort = Number(env.WEB_PORT);
    const server = createServer((socket) => {
      setupSockets.push(socket);
      healthConnections.push(healthPort);
      socket.end();
    });
    setupServers.push(server);
    server.once('error', (error) => callback?.(error, '', error.message));
    server.listen({ host: '127.0.0.1', port: healthPort }, () => callback?.(null, '', ''));
    return server as never;
  };
  const promisifySymbol = Symbol.for('nodejs.util.promisify.custom');
  Object.defineProperty(execFile, promisifySymbol, {
    value: (actual.execFile as unknown as Record<symbol, unknown>)[promisifySymbol],
  });
  return {
    ...actual,
    execFile,
  };
});

const tempRoot = realpathSync(mkdtempSync(path.join(os.homedir(), '.tmp-o8-manifest-launch-')));
const dataDir = path.join(tempRoot, 'data');
const repoPath = path.join(tempRoot, 'repo');
const worktreeRoot = path.join(tempRoot, 'worktrees');
const controlledEnvKeys = [
  'CORTEX_IDE_DATA_DIR',
  'O8_DATA_DIR',
  'O8_WORKTREE_ROOT',
  'O8_SKIP_PRELAUNCH_TYPECHECK',
] as const;
const priorEnv: Record<string, string | undefined> = {};

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

describe.sequential('workspace manifest packet launch real path', () => {
  beforeAll(async () => {
    for (const key of controlledEnvKeys) priorEnv[key] = process.env[key];
    mkdirSync(dataDir, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', repoPath]);
    writeFileSync(path.join(repoPath, 'README.md'), 'workspace manifest launch fixture\n');
    writeFileSync(path.join(repoPath, 'o8.workspace.json'), JSON.stringify({
      version: 1,
      setup: ['prepare-workspace'],
      services: [
        {
          name: 'api',
          command: 'run-api',
          port: { preferred: 43_300, env: 'API_PORT' },
        },
        {
          name: 'web',
          command: 'run-web',
          port: { preferred: 43_300, env: 'WEB_PORT' },
          health: { tcp: true, timeoutMs: 2_000 },
        },
      ],
      preview: { url: 'http://127.0.0.1:{{service:web}}' },
    }, null, 2));
    execFileSync('git', ['add', 'README.md', 'o8.workspace.json'], { cwd: repoPath });
    execFileSync('git', [
      '-c', 'user.email=test@o8.test',
      '-c', 'user.name=o8-test',
      'commit', '-qm', 'fixture',
    ], { cwd: repoPath });
    execFileSync('git', ['remote', 'add', 'origin', repoPath], { cwd: repoPath });

    process.env.CORTEX_IDE_DATA_DIR = dataDir;
    process.env.O8_DATA_DIR = dataDir;
    process.env.O8_WORKTREE_ROOT = worktreeRoot;
    process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';
    const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
    await updateOperatorDefaults({
      productTelemetryEnabled: false,
      storageReserveRatio: 0.0001,
      storageReserveFloorGb: 0.001,
    });
  });

  afterAll(async () => {
    for (const socket of setupSockets) socket.destroy();
    await Promise.all(setupServers.map(closeServer));
    const { closeDb } = await import('@/lib/db');
    closeDb();
    for (const key of controlledEnvKeys) {
      const prior = priorEnv[key];
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('allocates isolated ports, injects setup env, resolves previews, and releases terminal leases', async () => {
    const { createLane, getLane, getLaneEvents, setLaneStatus, updateLane } = await import(
      '@/lib/lane/registry'
    );
    const { prepareLaunchWorktree } = await import('@/lib/worktree/launch');
    const {
      allocateWorkspaceServicePorts,
      readWorkspacePortLeases,
      releaseWorkspacePortLeases,
    } = await import('@/lib/workspace/manifest/port-leases');

    const launch = async (packetId: string, branch: string) => {
      const lane = createLane({
        repoPath,
        branch,
        baseBranch: 'main',
        runtime: 'codex',
        label: packetId,
        packetId,
      });
      const prepared = await prepareLaunchWorktree({
        repoRoot: repoPath,
        agentType: 'codex',
        taskName: packetId,
        branchName: branch,
        baseBranch: 'main',
        isolate: true,
        skipSetup: true,
        packetId,
        laneId: lane.id,
      });
      if (!prepared) throw new Error(`Worktree launch returned no workspace for ${packetId}.`);
      updateLane(lane.id, { worktreePath: prepared.cwd }, 'system');
      return { lane, prepared };
    };

    const first = await launch('packet-manifest-first', 'test/manifest-first');
    const second = await launch('packet-manifest-second', 'test/manifest-second');
    const firstEvent = getLaneEvents(first.lane.id, 100).find(
      (event) => event.verb === 'workspace_manifest_applied',
    );
    const secondEvent = getLaneEvents(second.lane.id, 100).find(
      (event) => event.verb === 'workspace_manifest_applied',
    );
    expect(firstEvent).toBeDefined();
    expect(secondEvent).toBeDefined();

    const eventPorts = (event: NonNullable<typeof firstEvent>) => Object.fromEntries(
      (event.payload.services as Array<{ name: string; port: number }>)
        .map((service) => [service.name, service.port]),
    );
    const firstPorts = eventPorts(firstEvent!);
    const secondPorts = eventPorts(secondEvent!);
    expect(firstPorts).toEqual({ api: 43_300, web: 43_301 });
    expect(secondPorts.api).toBeGreaterThan(firstPorts.web);
    expect(secondPorts.web).toBeGreaterThan(secondPorts.api);
    expect(firstEvent?.payload.preview).toBe(`http://127.0.0.1:${firstPorts.web}`);
    expect(secondEvent?.payload.preview).toBe(`http://127.0.0.1:${secondPorts.web}`);

    const firstSetup = setupInvocations.find((invocation) => (
      invocation.cwd === first.prepared.cwd
    ));
    const secondSetup = setupInvocations.find((invocation) => (
      invocation.cwd === second.prepared.cwd
    ));
    expect(firstSetup?.env.API_PORT).toBe(String(firstPorts.api));
    expect(firstSetup?.env.WEB_PORT).toBe(String(firstPorts.web));
    expect(secondSetup?.env.API_PORT).toBe(String(secondPorts.api));
    expect(secondSetup?.env.WEB_PORT).toBe(String(secondPorts.web));
    expect(healthConnections).toEqual(expect.arrayContaining([firstPorts.web, secondPorts.web]));

    setLaneStatus(first.lane.id, 'completed', 'system', 'completed');
    await vi.waitFor(async () => {
      const leases = Object.values(await readWorkspacePortLeases());
      expect(leases.some((lease) => lease.laneId === first.lane.id)).toBe(false);
    }, { timeout: 30_000 });

    const replacement = await allocateWorkspaceServicePorts({
      packetId: 'packet-manifest-replacement',
      laneId: 'lane-manifest-replacement',
      services: [{ name: 'api', preferred: 43_300 }],
    });
    expect(replacement.api).toBe(firstPorts.api);
    await releaseWorkspacePortLeases({
      packetId: 'packet-manifest-replacement',
      laneId: 'lane-manifest-replacement',
    });

    setLaneStatus(second.lane.id, 'completed', 'system', 'completed');
    await vi.waitFor(() => {
      expect(getLane(first.lane.id)?.worktreePath).toBeNull();
      expect(getLane(second.lane.id)?.worktreePath).toBeNull();
    }, { timeout: 60_000 });
  }, 120_000);
});
