import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { POST, GET, DELETE } from '@/app/api/v2/chat-history/route';
import { getDataDir } from '@/lib/data-dir-migration';

// End-to-end verify for #1282: the real chat-history route must merge by default
// (a partial POST can't drop a stored turn) and full-replace only on replace:true.
// Uses a throwaway thoughts- tabId under the isolated test data dir; cleaned up.

const tabId = `thoughts-itest1282-${process.pid}-${Math.floor(performance.now())}`;

const post = (body: Record<string, unknown>) =>
  POST(new NextRequest('http://localhost/api/v2/chat-history', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));

async function storedIds(): Promise<string[]> {
  const res = await GET(new NextRequest(`http://localhost/api/v2/chat-history?tabId=${encodeURIComponent(tabId)}`));
  const data = await res.json();
  return (data.messages ?? []).map((m: { id: string }) => m.id);
}

async function storedMessages(): Promise<Array<Record<string, unknown>>> {
  const res = await GET(new NextRequest(`http://localhost/api/v2/chat-history?tabId=${encodeURIComponent(tabId)}`));
  const data = await res.json();
  return data.messages ?? [];
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

const user = { id: 'u1', role: 'user', timestamp: 100, content: 'Hey buddy' };
const assistant = { id: 'a1', role: 'assistant', timestamp: 101, content: 'hi!' };

afterAll(async () => {
  await DELETE(new NextRequest(`http://localhost/api/v2/chat-history?tabId=${encodeURIComponent(tabId)}`));
});

describe('chat-history route merge (#1282)', () => {
  it('a partial [user]-only POST does NOT drop the stored assistant reply', async () => {
    await post({ tabId, replace: true, messages: [user, assistant] }); // seed full turn
    await post({ tabId, messages: [user] });                            // the bug: partial POST
    expect(await storedIds()).toEqual(['u1', 'a1']);                    // reply survived
  });

  it('replace:true does a full replace (intentional truncation)', async () => {
    await post({ tabId, replace: true, messages: [user, assistant] }); // reset
    await post({ tabId, replace: true, messages: [user] });            // truncate
    expect(await storedIds()).toEqual(['u1']);                         // assistant dropped
  });

  it('keeps server-authored runtime attribution through a legacy full-transcript POST', async () => {
    await post({
      tabId,
      replace: true,
      messages: [user, { ...assistant, backend: 'codex', model: 'gpt-5.6', persistedVersion: 2 }],
    });
    await post({ tabId, messages: [user, assistant] });

    expect((await storedMessages()).find((message) => message.id === 'a1')).toMatchObject({
      backend: 'codex',
      model: 'gpt-5.6',
      persistedVersion: 2,
    });
  });

  it('serializes a stale client POST behind a worker receipt append', async () => {
    const receipt = { leadModel: 'gpt-5.6-sol', effort: 'high', mode: 'multitask' };
    await post({ tabId, replace: true, messages: [user, { ...assistant, receipt }] });
    const markerPath = join(getDataDir(), `chat-history-lock-${process.pid}`);
    rmSync(markerPath, { force: true });
    const childCode = `
      import { writeFileSync } from 'node:fs';
      const { withCanonicalChatHistoryLock } = (await import('./src/lib/llm/chat-history-store.ts')).default;
      const { appendMobileOrchestratorTurnWorker } = (await import('./src/lib/mobile/orchestrator-turn-receipt.ts')).default;
      withCanonicalChatHistoryLock(process.env.O8_TEST_TAB_ID, () => {
        writeFileSync(process.env.O8_TEST_LOCK_MARKER, 'locked');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 750);
        if (!appendMobileOrchestratorTurnWorker({
          tabId: process.env.O8_TEST_TAB_ID,
          messageId: 'a1',
          worker: { packetId: 'packet-race', runtime: 'codex', model: 'gpt-5.6-terra' },
        })) process.exitCode = 1;
      });
    `;
    const child = spawn(process.execPath, [
      '--import=./scripts/register-server-only-stub.mjs',
      '--import=tsx',
      '--input-type=module',
      '--eval',
      childCode,
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        O8_TEST_TAB_ID: tabId,
        O8_TEST_LOCK_MARKER: markerPath,
      },
      stdio: 'pipe',
    });
    const childExit = once(child, 'exit');
    await waitForFile(markerPath);
    expect((await post({ tabId, messages: [user, assistant] })).ok).toBe(true);
    const [exitCode] = await childExit;
    expect(exitCode).toBe(0);
    expect((await storedMessages()).find((message) => message.id === 'a1')).toMatchObject({
      receipt: {
        ...receipt,
        workers: [{ packetId: 'packet-race', runtime: 'codex', model: 'gpt-5.6-terra' }],
      },
    });
    rmSync(markerPath, { force: true });
  });
});
