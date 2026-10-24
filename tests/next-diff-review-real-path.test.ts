import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let server: ChildProcess;
let origin: string;
const token = 'fixture-next-review-operator';
const headers = { authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
beforeAll(async () => {
  server = spawn(process.execPath, ['--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx',
    'scripts/next/dev-server.ts', '--review'], {
    env: { ...process.env, O8_NEXT_API_TOKEN: token }, stdio: ['ignore', 'pipe', 'ignore'],
  });
  const lines = createInterface({ input: server.stdout! });
  for await (const line of lines) {
    try { origin = (JSON.parse(line) as { origin: string }).origin; } catch { continue; }
    if (origin) { lines.close(); break; }
  }
  expect(origin).toBeTruthy();
}, 30_000);
afterAll(async () => {
  if (server?.exitCode === null) { server.kill('SIGTERM'); await once(server, 'exit'); }
});

describe('o8 next diff/review through disposable production HTTP routes', () => {
  it('serves file states and pins review decisions, then refreshes persisted state', async () => {
    const diffResponse = await fetch(`${origin}/api/lanes/next-review-approve/diff?maxBytes=524288`, { headers });
    expect(diffResponse.status).toBe(200);
    const diff = await diffResponse.json();
    expect(diff).toMatchObject({ ok: true, truncated: false });
    expect(diff.headSha).toMatch(/^[a-f0-9]{40}$/);
    expect(diff.diff).toContain('new file mode');
    expect(diff.diff).toContain('deleted file mode');
    expect(diff.diff).toContain('rename from');
    expect(diff.diff).toContain('rename to');
    for (const approved of [false, true]) {
      const packetId = approved ? 'next-review-approve' : 'next-review-reject';
      const body = JSON.stringify({ packetId, approved, reviewedHeadSha: diff.headSha,
        findings: [], clientMutationId: `next-review-${approved}` });
      const url = `${origin}/api/orchestrator/review`;
      expect((await fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/json' } })).status).toBe(401);
      const response = await fetch(url, { method: 'POST', body, headers });
      expect(response.status).toBe(200);
      expect((await response.json()).result).toMatchObject({ recorded: true, reviewedHeadSha: diff.headSha });
      const replay = await fetch(url, { method: 'POST', body, headers });
      expect(replay.status).toBe(200);
      const state = await fetch(`${origin}/api/orchestrator/review-state?packetId=${packetId}`, { headers });
      expect(state.status).toBe(200);
      expect(await state.json()).toMatchObject({ packetId, orchestratorReview: { verdict: approved ? 'approved' : 'rejected' } });
    }
  }, 30_000);
});
