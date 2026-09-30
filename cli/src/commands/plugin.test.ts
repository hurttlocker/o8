import { afterEach, describe, expect, it, vi } from 'vitest';
import { runPlugin } from './plugin';

const revision = 'a'.repeat(64);
const inventory = {
  ok: true,
  installed: [{ manifest: { id: 'setup-check', name: 'Setup check', supportedPlatforms: ['darwin'], workspace: 'registered-project', actions: [{ id: 'check', description: 'Check setup', timeoutMs: 5000 }] }, revision, enabled: true, workspaceRoot: '/registered/project' }],
  receipts: [{ id: 'receipt-1', plugin_id: 'setup-check', action_id: 'check', revision, status: 'succeeded', started_at: '2026-09-29T00:00:00.000Z', actor: 'local-operator', actorKind: 'authorization-class', actorIdentity: null, exit_code: 0, stdout: 'ready\n', stderr: '', error: null }],
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('o8 plugin CLI', () => {
  it('lists bound actions and invokes an exact revision through the action API', async () => {
    vi.stubEnv('O8_API_PORT', '47120');
    vi.stubEnv('O8_API_TOKEN', 'operator-test-token');
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string, options?: RequestInit) => {
      calls.push({ url: String(url), body: options?.body ? JSON.parse(String(options.body)) : null });
      return new Response(JSON.stringify(options?.body
        ? { ok: true, receipt: { id: 'receipt-1', pluginId: 'setup-check', actionId: 'check', revision, status: 'succeeded', actor: 'local-operator', actorKind: 'authorization-class', actorIdentity: null, exitCode: 0, stdout: 'ready\n', stderr: '', error: null } }
        : inventory), { status: 200 });
    }));
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => { writes.push(String(chunk)); return true; }) as typeof process.stdout.write);
    const mode = { human: false, verbose: false };
    await expect(runPlugin(mode, 'action', ['list', '--plugin', 'setup-check'])).resolves.toBe(0);
    await expect(runPlugin(mode, 'action', ['invoke', 'setup-check', 'check', '--revision', revision, '--repo', '/registered/project'])).resolves.toBe(0);
    await expect(runPlugin(mode, 'log', ['list', '--plugin', 'setup-check'])).resolves.toBe(0);
    expect(calls[1].body).toEqual({ action: 'invoke', id: 'setup-check', actionId: 'check', revision, repo: '/registered/project' });
    expect(calls[2].url).toContain('/api/customize/actions?plugin=setup-check');
    expect(writes.join('')).toContain('o8/cli/plugin.action.list/v1');
    expect(writes.join('')).toContain('o8/cli/plugin.action.invoke/v1');
    expect(writes.join('')).toContain('o8/cli/plugin.log.list/v1');
    expect(writes.join('')).toContain('authorization-class');
  });

  it('refuses a worker credential before any plugin API call', async () => {
    vi.stubEnv('O8_WORKER_TOKEN', 'worker-test-token');
    vi.stubEnv('O8_API_TOKEN', 'operator-test-token');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(runPlugin({ human: false, verbose: false }, 'action', ['invoke', 'setup-check', 'check', '--revision', revision])).rejects.toMatchObject({ code: 'operator_required', exit: 3 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an explicit spectator credential even when an operator token is ambient', async () => {
    vi.stubEnv('O8_SPECTATOR_TOKEN', 'spectator-test-token');
    vi.stubEnv('O8_API_TOKEN', 'operator-test-token');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(runPlugin({ human: false, verbose: false }, 'list', [])).rejects.toMatchObject({ code: 'operator_required', exit: 3 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires an exact revision and rejects extra options', async () => {
    await expect(runPlugin({ human: false, verbose: false }, 'action', ['invoke', 'setup-check', 'check'])).rejects.toMatchObject({ code: 'invalid_args' });
    await expect(runPlugin({ human: false, verbose: false }, 'action', ['invoke', 'setup-check', 'check', '--revision', revision, '--actor', 'someone'])).rejects.toMatchObject({ code: 'invalid_args' });
  });
});
