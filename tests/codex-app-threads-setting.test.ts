import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * #3573: "Show chats in the Codex app" through the real operator-defaults route.
 * The Codex orchestrator session gates on resolveCodexAppThreadsSync(), the same
 * file-backed resolver this drives. Default is off: o8 writes to the operator's
 * Codex home only after an explicit opt-in.
 */
const dir = mkdtempSync(join(os.tmpdir(), 'o8-codex-app-threads-'));
process.env.CORTEX_IDE_DATA_DIR = dir;
process.env.O8_DATA_DIR = dir;

const { POST, GET } = await import('@/app/api/panel/operator-defaults/route');
const { resolveCodexAppThreadsSync } = await import('@/lib/operator/defaults');

function postReq(body: unknown): Request {
  return new Request('http://127.0.0.1/api/panel/operator-defaults', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('#3573: Codex app chats setting, real route round-trip', () => {
  it('defaults off, persists an opt-in to settings.toml, and the session resolver sees it', async () => {
    expect(resolveCodexAppThreadsSync()).toBe(false);

    const res = await POST(postReq({ codexAppThreads: true }));
    const payload = await res.json();
    expect(res.status).toBe(200);
    expect(payload.values.codexAppThreads).toBe(true);
    expect(payload.sources.codexAppThreads).toBe('file');
    expect(resolveCodexAppThreadsSync()).toBe(true);
    expect(readFileSync(join(dir, 'settings.toml'), 'utf8')).toMatch(/codex_app_threads = true/);

    const getPayload = await (await GET(new Request('http://127.0.0.1/api/panel/operator-defaults'))).json();
    expect(getPayload.values.codexAppThreads).toBe(true);

    const restore = await POST(postReq({ codexAppThreads: false }));
    expect((await restore.json()).values.codexAppThreads).toBe(false);
    expect(resolveCodexAppThreadsSync()).toBe(false);
  });

  it('rejects a non-boolean value through the real route', async () => {
    const res = await POST(postReq({ codexAppThreads: 'yes' }));
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
