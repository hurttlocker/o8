import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, expect, it, vi } from 'vitest';
const root = mkdtempSync(join(tmpdir(), 'o8-work-admission-'));
vi.stubEnv('O8_DATA_DIR', root);
vi.stubEnv('CORTEX_IDE_DATA_DIR', root);
const { createInlineTerminalHost } = await import('@/lib/ws-server/terminal-host-client');
afterAll(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
it('refuses a real terminal-host start while native restart owns admission', () => {
  const id = randomUUID();
  mkdirSync(join(root, 'cli-operation-admission'));
  writeFileSync(join(root, 'cli-operation-admission', `${id}.json`), JSON.stringify({ version: 1, id, kind: 'restart', pid: process.pid }));
  const spawn = vi.fn(() => ({ pid: process.pid, onExit: vi.fn() }));
  const host = createInlineTerminalHost({ spawn } as never);
  expect(() => host.spawn({ file: 'sh', args: [], cwd: root, env: {}, cols: 80, rows: 24 })).toThrow(/restart/i);
  expect(spawn).not.toHaveBeenCalled();
});

it('refuses dashboard tmux creation at the common helper before any new-session', async () => {
  const { createDashTmuxSessionSync } = await import('@/lib/ws-server/dash-terminal-persistence');
  const execFileSync = vi.fn(() => { throw new Error('no existing session'); });
  const result = createDashTmuxSessionSync({ enabled: true, sessionName: 'late-dash', cols: 80, rows: 24,
    cwd: root, shell: 'sh', env: { NODE_ENV: 'test' } }, { resolveTmuxBinary: () => 'tmux', execFileSync,
    recordHealth: vi.fn(), resolveProfileOwnerId: () => 'fixture' });
  expect(result).toBe(false);
  expect(execFileSync.mock.calls).toHaveLength(1); // has-session is read-only
});

it('refuses worker process creation under the same persisted native reservation', async () => {
  const { spawnWithWorkAdmission } = await import('@/lib/app-update/work-launch-admission');
  expect(() => spawnWithWorkAdmission(process.execPath, ['-e', 'process.exit(0)'])).toThrow(/restart/i);
});

it('retains an uncertain PTY lease when recording the already spawned PID fails', async () => {
  const { chmodSync, readdirSync, readFileSync } = await import('node:fs');
  rmSync(join(root, 'cli-operation-admission'), { recursive: true });
  const directory = join(root, 'work-launches');
  let file = '';
  let exited: (() => void) | undefined;
  const host = createInlineTerminalHost({ spawn() {
    file = join(directory, readdirSync(directory)[0]);
    chmodSync(file, 0o400);
    return { pid: process.pid, onExit(callback: () => void) { exited = callback; } };
  } } as never);
  host.spawn({ file: 'sh', args: [], cwd: root, env: {}, cols: 80, rows: 24 });
  expect(JSON.parse(readFileSync(file, 'utf8')).pid).toBeNull();
  expect(readdirSync(directory)).toHaveLength(1);
  exited?.();
  expect(readdirSync(directory)).toHaveLength(0);
});

it('settles a failed dashboard creation before allowing another restart', async () => {
  const { readdirSync } = await import('node:fs');
  const { createDashTmuxSessionSync } = await import('@/lib/ws-server/dash-terminal-persistence');
  const execFileSync = vi.fn(() => { throw Object.assign(new Error('tmux did not create a session'), { status: 1 }); });
  expect(createDashTmuxSessionSync({ enabled: true, sessionName: 'failed-dash', cols: 80, rows: 24,
    cwd: root, shell: 'sh', env: { NODE_ENV: 'test' } }, { resolveTmuxBinary: () => 'tmux', execFileSync,
    recordHealth: vi.fn(), resolveProfileOwnerId: () => 'fixture' })).toBe(false);
  expect(readdirSync(join(root, 'work-launches'))).toEqual([]);
});

it.each(['timeout', 'setup'])('retains the captured process when tmux %s follows a successful shell start', async failure => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { createDashTmuxSessionSync } = await import('@/lib/ws-server/dash-terminal-persistence');
  const execFileSync = vi.fn((_file: unknown, args: readonly string[]) => {
    if (args.includes('has-session')) throw Object.assign(new Error('absent'), { status: 1 });
    if (args.includes('new-session')) {
      if (failure === 'timeout') throw Object.assign(new Error('timed out after spawn'), { signal: 'SIGTERM', status: null });
      return String(process.pid);
    }
    if (args.includes('display-message')) return String(process.pid);
    if (args.includes('set-option')) throw new Error('setup failed');
    return '';
  });
  expect(createDashTmuxSessionSync({ enabled: true, sessionName: `partial-${failure}`, cols: 80, rows: 24,
    cwd: root, shell: 'sh', env: { NODE_ENV: 'test' } }, { resolveTmuxBinary: () => 'tmux', execFileSync: execFileSync as never,
    recordHealth: vi.fn(), resolveProfileOwnerId: () => 'fixture' })).toBe(false);
  const directory = join(root, 'work-launches');
  const files = readdirSync(directory);
  expect(files).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(directory, files[0]), 'utf8')).pid).toBe(process.pid);
  rmSync(join(directory, files[0]));
});
