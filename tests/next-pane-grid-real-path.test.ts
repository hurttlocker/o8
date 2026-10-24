import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import WebSocket from 'ws';

it('serves six persisted grid sessions and independent live history streams through the fixture host', async () => {
  const child = spawn(process.execPath, ['--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx',
    'scripts/next/grid-dev-server.ts'], {
    env: { ...process.env, O8_NEXT_API_TOKEN: 'fixture-grid-bearer' }, stdio: ['ignore', 'pipe', 'ignore'],
  });
  const sockets: WebSocket[] = [];
  try {
    const lines = createInterface({ input: child.stdout });
    let origin = '';
    for await (const line of lines) {
      try { origin = (JSON.parse(line) as { origin?: string }).origin ?? ''; } catch { /* startup log */ }
      if (origin) break;
    }
    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const headers = { Authorization: 'Bearer fixture-grid-bearer' };
    const response = await fetch(`${origin}/api/mobile/orchestrator/threads?limit=500`, { headers });
    expect(response.status).toBe(200);
    const { threads } = await response.json() as { threads: Array<{ id: string; title: string }> };
    const workers = threads.filter(thread => thread.id.startsWith('thoughts-grid-'));
    expect(workers, 'six persisted workers must be reachable through the production session route').toHaveLength(6);
    const inventoryResponse = await fetch(`${origin}/api/runtime/inventory?fresh=1`, { headers });
    expect(inventoryResponse.status, 'runtime workers must be reachable through the production inventory route').toBe(200);
    const inventory = await inventoryResponse.json() as { agents: Array<{ sessionKey: string }> };
    expect(inventory.agents.map(agent => agent.sessionKey)).toContain('pi-owned:grid-runtime');
    const runtimeHistory = await (await fetch(`${origin}/api/mobile/history?sessionKey=pi-owned:grid-runtime`, { headers })).json() as {
      sessionKey: string; transcript: Array<{ text: string }>;
    };
    expect(runtimeHistory.sessionKey).toBe('pi-owned:grid-runtime');
    expect(runtimeHistory.transcript.some(entry => entry.text === 'Persisted grid runtime answer')).toBe(true);
    const info = await (await fetch(`${origin}/api/panel/ws-info`, { headers })).json() as { wsPort: number; wsToken: string };
    await Promise.all(workers.map(async worker => {
      const key = `llm-chat:${worker.id}`;
      const history = await (await fetch(`${origin}/api/mobile/history?${new URLSearchParams({ sessionKey: key })}`, { headers })).json() as {
        sessionKey: string; transcript: Array<{ text: string }>;
      };
      expect(history.sessionKey).toBe(key);
      expect(history.transcript.at(-1)?.text).toContain(worker.id);
      const ws = new WebSocket(`ws://127.0.0.1:${info.wsPort}/ws?token=${info.wsToken}`);
      sockets.push(ws);
      const checkpoint = new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Missing independent grid checkpoint')), 5000);
        ws.on('message', bytes => {
          const frame = JSON.parse(String(bytes)) as { channel: string; data: { events?: Array<{ data: Record<string, unknown> }> } };
          const event = frame.data?.events?.find(event => event.data.sessionKey === key);
          if (event) { clearTimeout(timer); resolve(event.data); }
        });
        ws.once('error', reject);
      });
      await once(ws, 'open');
      ws.send(JSON.stringify({ type: 'realtime-subscribe', subscriptions: [{ stream: `session:${key}` }] }));
      expect((await checkpoint).sessionKey).toBe(key);
    }));
  } finally {
    for (const ws of sockets) ws.terminate();
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
}, 30_000);
