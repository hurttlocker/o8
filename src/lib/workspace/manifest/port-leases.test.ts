import { createServer, type Server } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';

import { afterAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(`${os.tmpdir()}/o8-workspace-port-leases-`);
const priorDataDir = process.env.CORTEX_IDE_DATA_DIR;
const priorO8DataDir = process.env.O8_DATA_DIR;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;

const {
  allocateWorkspaceServicePorts,
  releaseWorkspacePortLeases,
} = await import('./port-leases');

function listenEphemeral(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Listener returned no TCP port.'));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

afterAll(() => {
  if (priorDataDir === undefined) delete process.env.CORTEX_IDE_DATA_DIR;
  else process.env.CORTEX_IDE_DATA_DIR = priorDataDir;
  if (priorO8DataDir === undefined) delete process.env.O8_DATA_DIR;
  else process.env.O8_DATA_DIR = priorO8DataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe.sequential('workspace manifest port leases', () => {
  it('walks past the complete o8 reserved port block', async () => {
    const ports = await allocateWorkspaceServicePorts({
      packetId: 'packet-reserved',
      laneId: 'lane-reserved',
      services: [{ name: 'api', preferred: 47_100 }],
    });

    expect(ports.api).toBe(47_112);
    expect(await releaseWorkspacePortLeases({
      packetId: 'packet-reserved',
      laneId: 'lane-reserved',
    })).toBe(1);
  });

  it('walks past a port held by a real TCP listener', async () => {
    const { server, port } = await listenEphemeral();
    try {
      const ports = await allocateWorkspaceServicePorts({
        packetId: 'packet-bound',
        laneId: 'lane-bound',
        services: [{ name: 'web', preferred: port }],
      });

      expect(ports.web).toBeGreaterThan(port);
      expect(await releaseWorkspacePortLeases({
        packetId: 'packet-bound',
        laneId: 'lane-bound',
      })).toBe(1);
    } finally {
      await closeServer(server);
    }
  });

  it('isolates lanes and makes released ports available again', async () => {
    const preferred = 43_210;
    const first = await allocateWorkspaceServicePorts({
      packetId: 'packet-first',
      laneId: 'lane-first',
      services: [{ name: 'api', preferred }],
    });
    const second = await allocateWorkspaceServicePorts({
      packetId: 'packet-second',
      laneId: 'lane-second',
      services: [{ name: 'api', preferred }],
    });

    expect(first.api).toBe(preferred);
    expect(second.api).toBeGreaterThan(preferred);
    expect(await releaseWorkspacePortLeases({
      packetId: 'packet-first',
      laneId: 'lane-first',
    })).toBe(1);

    const replacement = await allocateWorkspaceServicePorts({
      packetId: 'packet-replacement',
      laneId: 'lane-replacement',
      services: [{ name: 'api', preferred }],
    });
    expect(replacement.api).toBe(preferred);

    await releaseWorkspacePortLeases({ packetId: 'packet-second', laneId: 'lane-second' });
    await releaseWorkspacePortLeases({
      packetId: 'packet-replacement',
      laneId: 'lane-replacement',
    });
  });
});
