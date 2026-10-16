import { EventEmitter } from 'node:events';
import { NextRequest } from 'next/server';
import { expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('child_process', () => ({ spawn: fixture.spawn }));
vi.mock('@/lib/lane/repo-preflight', () => ({ assertOrchestratorRepoPath: () => undefined }));
vi.mock('@/lib/runtimes/shared/cli-resolver', () => ({ resolveCli: async () => ({ path: '/fixture/codex' }), CliNotFoundError: class extends Error {} }));
vi.mock('@/lib/runtimes/shared/cli-spawn', () => ({ cliInvocation: (command: string, args: string[]) => ({ command, args }) }));
import { POST } from './route';
it('emits a proven rejected delivery when the CLI process cannot spawn', async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { end: () => queueMicrotask(() => child.emit('error', new Error('fixture spawn failed'))) } });
  fixture.spawn.mockReturnValue(child);
  const response = await POST(new NextRequest('http://localhost/api/codex/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'fixture' }) }));
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('"delivery":"rejected"');
  expect(fixture.spawn).toHaveBeenCalledTimes(1);
});
