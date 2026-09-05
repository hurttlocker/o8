import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-worker-start-mode-'));
const originalDataDir = process.env.CORTEX_IDE_DATA_DIR;
const originalO8DataDir = process.env.O8_DATA_DIR;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;

const { GET, POST } = await import('@/app/api/panel/operator-defaults/route');

function post(body: unknown): Request {
  return new Request('http://127.0.0.1/api/panel/operator-defaults', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.CORTEX_IDE_DATA_DIR;
  else process.env.CORTEX_IDE_DATA_DIR = originalDataDir;
  if (originalO8DataDir === undefined) delete process.env.O8_DATA_DIR;
  else process.env.O8_DATA_DIR = originalO8DataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe.sequential('worker start mode real Settings path', () => {
  it('defaults to autonomous and persists an ask-first selection', async () => {
    const initial = await (await GET(new Request('http://127.0.0.1/api/panel/operator-defaults'))).json();
    expect(initial.values.workerStartMode).toBe('autonomous');

    const response = await POST(post({ workerStartMode: 'huddle' }));
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.values.workerStartMode).toBe('huddle');
    expect(payload.sources.workerStartMode).toBe('file');

    const settings = readFileSync(join(dataDir, 'settings.toml'), 'utf8');
    expect(settings).toContain('worker_start_mode = "huddle"');
  });

  it('rejects an unknown start mode without changing the saved choice', async () => {
    const response = await POST(post({ workerStartMode: 'surprise-me' }));
    expect(response.status).toBe(400);
    expect((await (await GET(new Request('http://127.0.0.1/api/panel/operator-defaults'))).json()).values.workerStartMode).toBe('huddle');
  });
});
