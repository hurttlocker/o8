import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { NextRequest } from 'next/server';
import { GET, POST } from './route';

const dataDir = process.env.CORTEX_IDE_DATA_DIR!;
const catalogPath = join(dataDir, 'ssh-machines.json');
const machine = {
  id: '12345678-1234-1234-1234-123456789abc', label: 'Studio', target: 'fixture@localhost',
  port: 2200, remoteCli: 'o8', sshConfig: null, enabled: true,
};

beforeEach(() => {
  writeFileSync(catalogPath, JSON.stringify({ schema: 'o8/cli/machines/v1', machines: [machine] }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(catalogPath, { force: true });
  rmSync(join(dataDir, 'fake-ssh'), { recursive: true, force: true });
  rmSync(join(dataDir, 'cli'), { recursive: true, force: true });
});

it('lists saved profiles and their live remote terminals through the panel route', async () => {
  const bin = join(dataDir, 'fake-ssh');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'ssh'), '#!/bin/sh\nprintf "%s\\n" \'{"schema":"o8/cli/terminal.list/v1","sessions":[{"id":"dash-1"}]}\'\n', { mode: 0o755 });
  vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH ?? ''}`);
  const list = await GET(new NextRequest('http://localhost/api/panel/ssh-machines', { headers: { host: 'localhost' } }));
  expect(list.status).toBe(200);
  expect(await list.json()).toMatchObject({ machines: [{ id: machine.id, label: 'Studio', enabled: true }] });
  const inventory = await GET(new NextRequest(`http://localhost/api/panel/ssh-machines?machine=${machine.id}`, { headers: { host: 'localhost' } }));
  expect(inventory.status).toBe(200);
  expect(await inventory.json()).toMatchObject({ sessions: [{ id: 'dash-1' }] });
  const sourceCliDir = join(dataDir, 'cli', 'dist');
  mkdirSync(sourceCliDir, { recursive: true });
  writeFileSync(join(sourceCliDir, 'o8.mjs'), '');
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(dataDir);
  try {
    const opened = await POST(new NextRequest('http://localhost/api/panel/ssh-machines', {
      method: 'POST', headers: { host: 'localhost' }, body: JSON.stringify({ machineId: machine.id, sessionId: 'dash-1' }),
    }));
    expect(opened.status).toBe(200);
    expect(await opened.json()).toMatchObject({
      schema: 'o8/panel/ssh-machine-control/v1',
      machine: { id: machine.id, label: 'Studio' },
      sessionId: 'dash-1',
      command: expect.stringContaining(`--human terminal control 'dash-1' --machine '${machine.id}'`),
    });
  } finally {
    cwd.mockRestore();
  }
  const missing = await POST(new NextRequest('http://localhost/api/panel/ssh-machines', {
    method: 'POST', headers: { host: 'localhost' }, body: JSON.stringify({ machineId: machine.id, sessionId: 'gone' }),
  }));
  expect(missing.status).toBe(404);
  expect(await missing.json()).toMatchObject({ error: { code: 'terminal_not_found' } });
});

it('rejects a nonlocal caller before reading the machine catalog', async () => {
  const response = await GET(new NextRequest('http://localhost/api/panel/ssh-machines', {
    headers: { 'x-o8-client-addr': '192.0.2.1' },
  }));
  expect([401, 403]).toContain(response.status);
});

it('returns a structured client error for malformed control requests', async () => {
  const response = await POST(new NextRequest('http://localhost/api/panel/ssh-machines', {
    method: 'POST', headers: { host: 'localhost' }, body: '{',
  }));
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: 'invalid_args' } });
});
