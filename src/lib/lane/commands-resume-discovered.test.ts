import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLane, getLane, updateLane } from '@/lib/lane/registry';
import { getRuntime } from '@/lib/runtimes/registry';
import { registerRuntimeTerminalSession } from '@/lib/runtime/terminal-session-registry';
import { dispatch } from './commands';

const h = vi.hoisted(() => ({
  launch: vi.fn(),
  steer: vi.fn(),
  claudeProbe: vi.fn(),
}));

vi.mock('@/lib/runtime/actions', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/runtime/actions')>(),
  launchRuntimeSurface: h.launch,
  performRuntimeAction: h.steer,
}));
vi.mock('@/lib/runtimes/claude-code-process-probe', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/runtimes/claude-code-process-probe')>(),
  probeLiveClaudeProcesses: h.claudeProbe,
}));

describe('lane resume with an external CLI session', () => {
  beforeEach(() => {
    h.claudeProbe.mockResolvedValue({ processes: [], probed: true });
  });
  afterEach(() => {
    h.launch.mockReset();
    h.steer.mockReset();
    h.claudeProbe.mockReset();
  });

  it.each([
    ['codex', 'codex:discovered-thread', undefined],
    ['codex', 'codex-discovered:discovered-thread', undefined],
    ['codex', 'codex-live:12345', 'Continue the work'],
    ['claude-code', 'claude-code:discovered-thread', undefined],
    ['claude-code', 'claude-code-discovered:discovered-thread', undefined],
    ['claude-code', 'claude-code:live-12345', 'Continue the work'],
  ] as const)('refuses %s %s without replacing the original session', async (runtime, sessionKey, message) => {
    const lane = createLane({
      repoPath: process.cwd(),
      branch: `test/discovered-resume-${runtime}-${sessionKey.replaceAll(':', '-')}`,
      runtime,
      sessionKey,
    });
    updateLane(lane.id, { status: 'awaiting_input' }, 'system');
    const before = getLane(lane.id);

    const result = await dispatch({ verb: 'resume', laneId: lane.id, message, actor: 'user' });

    expect(result).toMatchObject({ ok: false, reason: 'cli_resume_requires_explicit_action' });
    expect(result.note).toContain('original terminal');
    expect(getLane(lane.id)).toMatchObject({
      sessionKey,
      status: before?.status,
      lastEventLabel: before?.lastEventLabel,
    });
    expect(h.launch).not.toHaveBeenCalled();
    expect(h.steer).not.toHaveBeenCalled();
  });

  it.each([
    ['codex', 'codex:live-thread'],
    ['claude-code', 'claude-code:live-thread'],
  ] as const)('refuses an explicit fresh %s run while its original CLI is live', async (runtimeId, sessionKey) => {
    const lane = createLane({ repoPath: process.cwd(), branch: `test/fresh-live-${runtimeId}`, runtime: runtimeId, sessionKey });
    updateLane(lane.id, { status: 'awaiting_human' }, 'system');
    const runtime = getRuntime(runtimeId);
    expect(runtime).toBeDefined();
    const discover = vi.spyOn(runtime!, 'discoverSessions').mockResolvedValue([{
      sessionKey, runtimeId, status: 'running', ownership: 'discovered', pid: 42,
    } as import('@/lib/runtimes/types').RuntimeSession]);
    registerRuntimeTerminalSession(sessionKey, {
      runtime: runtimeId, sessionName: `cortex-dash-live-${runtimeId}`, cwd: process.cwd(), source: 'dashboard-cli-detected', pid: process.pid,
    });

    const result = await dispatch({ verb: 'start_fresh', laneId: lane.id, expectedSessionKey: sessionKey, actor: 'user' });

    expect(result).toMatchObject({ ok: false, reason: 'original_session_live' });
    expect(discover).not.toHaveBeenCalled();
    expect(getLane(lane.id)).toMatchObject({ sessionKey, status: 'awaiting_human' });
    expect(h.launch).not.toHaveBeenCalled();
    discover.mockRestore();
  });

  it.each([
    ['codex', 'codex:no-pid-proof'],
    ['claude-code', 'claude-code:no-pid-proof'],
  ] as const)('does not treat an empty %s discovery scan as proof the original CLI stopped', async (runtimeId, sessionKey) => {
    const lane = createLane({ repoPath: process.cwd(), branch: `test/fresh-unverified-${runtimeId}`, runtime: runtimeId, sessionKey });
    updateLane(lane.id, { status: 'recovering' }, 'system');
    const runtime = getRuntime(runtimeId);
    expect(runtime).toBeDefined();
    const discover = vi.spyOn(runtime!, 'discoverSessions').mockResolvedValue([]);

    const result = await dispatch({ verb: 'start_fresh', laneId: lane.id, expectedSessionKey: sessionKey, actor: 'user' });
    expect(result).toMatchObject({ ok: false, reason: 'original_stop_unverified' });
    expect(h.launch).not.toHaveBeenCalled();
    expect(discover).not.toHaveBeenCalled();
    discover.mockRestore();
  });

  it.each([
    ['codex', 'codex:partial-scan'],
    ['claude-code', 'claude-code:partial-scan'],
  ] as const)('refuses a fresh %s run when the runtime scan omits the prior session', async (runtimeId, sessionKey) => {
    const lane = createLane({ repoPath: process.cwd(), branch: `test/fresh-partial-${runtimeId}`, runtime: runtimeId, sessionKey });
    updateLane(lane.id, { status: 'recovering' }, 'system');
    registerRuntimeTerminalSession(sessionKey, {
      runtime: runtimeId, sessionName: `cortex-dash-partial-${runtimeId}`, cwd: process.cwd(), source: 'dashboard-cli-detected', pid: 999_999,
    });
    const runtime = getRuntime(runtimeId);
    expect(runtime).toBeDefined();
    const discover = vi.spyOn(runtime!, 'discoverSessions').mockResolvedValue([]);

    const result = await dispatch({ verb: 'start_fresh', laneId: lane.id, expectedSessionKey: sessionKey, actor: 'user' });
    expect(result).toMatchObject({ ok: false, reason: 'session_state_unknown' });
    expect(discover).toHaveBeenCalledWith({ fresh: true });
    expect(h.launch).not.toHaveBeenCalled();
    discover.mockRestore();
  });

  it('refuses a fresh Claude run when the live process probe is unavailable', async () => {
    const sessionKey = 'claude-code:probe-unavailable';
    const lane = createLane({ repoPath: process.cwd(), branch: 'test/fresh-claude-probe', runtime: 'claude-code', sessionKey });
    updateLane(lane.id, { status: 'recovering' }, 'system');
    registerRuntimeTerminalSession(sessionKey, {
      runtime: 'claude-code', sessionName: 'cortex-dash-probe-unavailable', cwd: process.cwd(), source: 'dashboard-cli-detected', pid: 999_999,
    });
    h.claudeProbe.mockResolvedValue({ processes: [], probed: false });
    const runtime = getRuntime('claude-code');
    const discover = vi.spyOn(runtime!, 'discoverSessions');

    const result = await dispatch({ verb: 'start_fresh', laneId: lane.id, expectedSessionKey: sessionKey, actor: 'user' });
    expect(result).toMatchObject({ ok: false, reason: 'session_state_unknown' });
    expect(discover).not.toHaveBeenCalled();
    expect(h.launch).not.toHaveBeenCalled();
    discover.mockRestore();
  });

  it('starts a new run only after the old session is absent and the key still matches', async () => {
    const sessionKey = 'codex:stopped-thread';
    const lane = createLane({ repoPath: process.cwd(), branch: 'test/fresh-stopped-codex', runtime: 'codex', sessionKey });
    updateLane(lane.id, { status: 'recovering' }, 'system');
    const runtime = getRuntime('codex');
    expect(runtime).toBeDefined();
    registerRuntimeTerminalSession(sessionKey, {
      runtime: 'codex', sessionName: 'cortex-dash-stopped-test', cwd: process.cwd(), source: 'dashboard-cli-detected', pid: 999_999,
    });
    const discover = vi.spyOn(runtime!, 'discoverSessions').mockResolvedValue([{
      sessionKey, runtimeId: 'codex', status: 'idle', ownership: 'discovered',
    } as import('@/lib/runtimes/types').RuntimeSession]);
    h.launch.mockResolvedValue({ ok: true, surfaceId: 'codex-owned:new-run', note: 'Launched.' });

    const stale = await dispatch({ verb: 'start_fresh', laneId: lane.id, expectedSessionKey: 'codex:other', actor: 'user' });
    expect(stale).toMatchObject({ ok: false, reason: 'fresh_run_stale' });
    expect(h.launch).not.toHaveBeenCalled();

    const result = await dispatch({ verb: 'start_fresh', laneId: lane.id, expectedSessionKey: sessionKey, actor: 'user' });
    expect(result.ok).toBe(true);
    expect(result.note).toContain('new run');
    expect(getLane(lane.id)).toMatchObject({ status: 'running', sessionKey: 'codex-owned:new-run' });
    expect(h.launch).toHaveBeenCalledTimes(1);
    expect(h.steer).not.toHaveBeenCalled();
    discover.mockRestore();
  });

  it('serializes two confirmed fresh requests so only one CLI process launches', async () => {
    const sessionKey = 'claude-code:stopped-concurrent-thread';
    const lane = createLane({ repoPath: process.cwd(), branch: 'test/fresh-concurrent-claude', runtime: 'claude-code', sessionKey });
    updateLane(lane.id, { status: 'recovering' }, 'system');
    registerRuntimeTerminalSession(sessionKey, {
      runtime: 'claude-code', sessionName: 'cortex-dash-stopped-concurrent', cwd: process.cwd(), source: 'dashboard-cli-detected', pid: 999_999,
    });
    const runtime = getRuntime('claude-code');
    expect(runtime).toBeDefined();
    const discover = vi.spyOn(runtime!, 'discoverSessions').mockResolvedValue([{
      sessionKey, runtimeId: 'claude-code', status: 'idle', ownership: 'discovered',
    } as import('@/lib/runtimes/types').RuntimeSession]);
    let releaseLaunch!: () => void;
    const gate = new Promise<void>((resolve) => { releaseLaunch = resolve; });
    let enteredLaunch!: () => void;
    const entered = new Promise<void>((resolve) => { enteredLaunch = resolve; });
    h.launch.mockImplementation(async () => {
      enteredLaunch();
      await gate;
      return { ok: true, surfaceId: 'claude-code-owned:one-run', note: 'Launched.' };
    });

    const command = { verb: 'start_fresh' as const, laneId: lane.id, expectedSessionKey: sessionKey, actor: 'user' as const };
    const first = dispatch(command);
    const second = dispatch(command);
    await entered;
    expect(h.launch).toHaveBeenCalledTimes(1);
    releaseLaunch();
    const [a, b] = await Promise.all([first, second]);
    expect(a.ok).toBe(true);
    expect(b).toMatchObject({ ok: false, reason: 'fresh_run_stale' });
    expect(h.launch).toHaveBeenCalledTimes(1);
    discover.mockRestore();
  }, 20_000);
});
