import { mkdtempSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Real-path test for GET /api/panel/ws-info (the WS credential self-heal
 * seam, 2026-07-12): the route must return the port that ACTUALLY answers —
 * the sidecar's port file wins over the env-resolved value whenever the
 * file's port is the one listening (the dev-bridge case where dev.mjs's
 * WS_PORT env points at a ws-server that doesn't exist).
 */

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-ws-info-'));
let liveServer: net.Server;
let livePort: number;

beforeAll(async () => {
  process.env.CORTEX_IDE_DATA_DIR = dataDir;
  // A real listener — the route's TCP probe must find THIS port.
  liveServer = net.createServer();
  await new Promise<void>((resolve) => liveServer.listen(0, '127.0.0.1', resolve));
  livePort = (liveServer.address() as net.AddressInfo).port;
  writeFileSync(path.join(dataDir, 'ws-port'), String(livePort));
  writeFileSync(path.join(dataDir, 'ws-token'), 'test-token-0123456789abcdef');
  // Env resolution would pick this DEAD port without the liveness probe.
  process.env.O8_WS_PORT = '59999';
});

afterAll(async () => {
  delete process.env.O8_WS_PORT;
  delete process.env.CORTEX_IDE_DATA_DIR;
  await new Promise<void>((resolve) => liveServer.close(() => resolve()));
});

describe('GET /api/panel/ws-info (real route handler)', () => {
  it('returns the LISTENING port from the sidecar file, not the dead env port, plus the token', async () => {
    const { GET } = await import('@/app/api/panel/ws-info/route');
    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json() as { wsPort: number; wsToken: string };
    expect(body.wsPort).toBe(livePort);
    expect(body.wsPort).not.toBe(59999);
    expect(body.wsToken).toBe('test-token-0123456789abcdef');
  });
});
