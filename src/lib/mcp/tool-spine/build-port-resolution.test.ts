import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  resetToolSpinePortIdentityForTests,
  resolveToolSpineApiBase,
  resolveToolSpineWsPort,
} from './build';

const originalDataDir = process.env.CORTEX_IDE_DATA_DIR;
const originalO8WsPort = process.env.O8_WS_PORT;
const originalWsPort = process.env.WS_PORT;
const originalApiPort = process.env.O8_API_PORT;
const originalPort = process.env.PORT;
const originalCortexPort = process.env.CORTEX_IDE_PORT;
const tempDirs: string[] = [];

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.CORTEX_IDE_DATA_DIR;
  else process.env.CORTEX_IDE_DATA_DIR = originalDataDir;
  if (originalO8WsPort === undefined) delete process.env.O8_WS_PORT;
  else process.env.O8_WS_PORT = originalO8WsPort;
  if (originalWsPort === undefined) delete process.env.WS_PORT;
  else process.env.WS_PORT = originalWsPort;
  if (originalApiPort === undefined) delete process.env.O8_API_PORT;
  else process.env.O8_API_PORT = originalApiPort;
  if (originalPort === undefined) delete process.env.PORT;
  else process.env.PORT = originalPort;
  if (originalCortexPort === undefined) delete process.env.CORTEX_IDE_PORT;
  else process.env.CORTEX_IDE_PORT = originalCortexPort;
  resetToolSpinePortIdentityForTests();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('resolveToolSpineWsPort', () => {
  it('keeps a process-pinned WS port stable across volatile ws-port file rewrites', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'o8-tool-spine-port-'));
    tempDirs.push(dataDir);
    process.env.CORTEX_IDE_DATA_DIR = dataDir;
    process.env.O8_WS_PORT = '47105';
    delete process.env.WS_PORT;

    writeFileSync(join(dataDir, 'ws-port'), '47201\n');
    expect(resolveToolSpineWsPort()).toBe('47105');
    writeFileSync(join(dataDir, 'ws-port'), '47202\n');
    expect(resolveToolSpineWsPort()).toBe('47105');
  });

  it('keeps identical-turn API and WS config stable when sidecar port files rotate', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'o8-tool-spine-file-port-'));
    tempDirs.push(dataDir);
    process.env.CORTEX_IDE_DATA_DIR = dataDir;
    delete process.env.O8_API_PORT;
    delete process.env.PORT;
    delete process.env.CORTEX_IDE_PORT;
    delete process.env.O8_WS_PORT;
    delete process.env.WS_PORT;
    resetToolSpinePortIdentityForTests();

    writeFileSync(join(dataDir, 'api-port'), '47201\n');
    writeFileSync(join(dataDir, 'ws-port'), '47202\n');
    const first = { apiBase: resolveToolSpineApiBase(), wsPort: resolveToolSpineWsPort() };
    writeFileSync(join(dataDir, 'api-port'), '47301\n');
    writeFileSync(join(dataDir, 'ws-port'), '47302\n');

    expect({ apiBase: resolveToolSpineApiBase(), wsPort: resolveToolSpineWsPort() }).toEqual(first);
  });
});
