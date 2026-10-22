import { rmSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDataDir } from '@/lib/data-dir-migration';
import { getSqlite } from '@/lib/db';
import { launchAgentCounterPath, markLaunchAgentHealthy, recordLaunchAgentStart } from '@/lib/mcp/launch-agent-crash-counter';
import { dismissInboxItem, listInboxItems } from '@/lib/supervisor/inbox';
import { surfaceLaunchAgentCrashLoops } from './launch-agent-health';

const { probe } = vi.hoisted(() => ({ probe: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(),
  execFileSync: probe,
  execFile: (...args: unknown[]) => {
    const callback = args.pop() as (error: Error | null, stdout: string, stderr: string) => void;
    Promise.resolve().then(() => probe(...args)).then(
      (stdout) => callback(null, stdout, ''), (error) => callback(error, '', ''),
    );
  },
}));

const platform = process.platform;
const MINUTE = 60_000;
let label: string;
let sequence = 0;
let now: number;

function running(pid = 123, runs = 4) {
  return `gui/501/${label} = {\n\tstate = running\n\truns = ${runs}\n\tpid = ${pid}\n}\n`;
}

function incidents() {
  return listInboxItems({ includeAllProjects: true }).filter((item) => (
    item.kind === 'launch_agent_crash_loop' && item.payload.label === label
  ));
}

async function startLoop(at = now) {
  for (let offset = 3; offset >= 0; offset -= 1) {
    recordLaunchAgentStart({ dataDir: getDataDir(), label, parentPid: 1, nowMs: at - offset * 1_000 });
  }
  await surfaceLaunchAgentCrashLoops(at);
  return incidents()[0];
}

async function observe(from: number, minutes: number) {
  for (let minute = 1; minute <= minutes; minute += 1) await surfaceLaunchAgentCrashLoops(from + minute * MINUTE);
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  label = `com.o8.test-recovery-${++sequence}`;
  now = Date.now();
  probe.mockReset().mockImplementation(() => running());
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform });
  rmSync(launchAgentCounterPath(getDataDir(), label), { force: true });
});

describe('scheduled LaunchAgent recovery through persisted inbox records', () => {
  it('requires sustained observations and records recovery evidence without erasing the incident', async () => {
    const incident = await startLoop();
    await observe(now, 4);
    expect(incidents()[0].status).toBe('human_required');
    await surfaceLaunchAgentCrashLoops(now + 5 * MINUTE);

    const row = getSqlite().prepare('SELECT status, resolved_at, payload FROM supervisor_inbox WHERE id = ?').get(incident.id) as {
      status: string; resolved_at: string; payload: string;
    };
    expect(row.status).toBe('resolved');
    expect(row.resolved_at).toBe(new Date(now + 5 * MINUTE).toISOString());
    expect(JSON.parse(row.payload)).toMatchObject({
      label, failureCount: 3,
      autoResolution: {
        event: 'launch_agent_recovered', probeKind: 'launchctl_print',
        evidence: { pid: 123, runs: 4, observedFromMs: now, observedThroughMs: now + 5 * MINUTE, healthyWindowMs: 5 * MINUTE, latestStartAtMs: now },
      },
    });
    expect(probe).toHaveBeenCalledWith('launchctl', ['print', `gui/${process.getuid!()}/${label}`], expect.objectContaining({ timeout: 2_000, encoding: 'utf8' }));
  });

  it.each(['failed probe', 'stopped', 'malformed probe', 'nested process', 'missing history', 'malformed history', 'invalid timestamps', 'future timestamps', 'unsupported platform'])('keeps %s active', async (state) => {
    await startLoop();
    if (state === 'failed probe') probe.mockImplementation(() => { throw new Error('probe unavailable'); });
    if (state === 'stopped') probe.mockReturnValue(`service = {\n\tstate = waiting\n\truns = 4\n}\n`);
    if (state === 'malformed probe') probe.mockReturnValue('state = running\npid = 123');
    if (state === 'nested process') probe.mockReturnValue('service = {\n\tresource = {\n\t\tstate = running\n\t\tpid = 123\n\t\truns = 4\n\t}\n}\n');
    if (state === 'missing history') rmSync(launchAgentCounterPath(getDataDir(), label));
    if (state === 'malformed history') writeFileSync(launchAgentCounterPath(getDataDir(), label), '{');
    if (state === 'invalid timestamps') writeFileSync(launchAgentCounterPath(getDataDir(), label), JSON.stringify({ label, startsMs: ['invalid'] }));
    if (state === 'future timestamps') writeFileSync(launchAgentCounterPath(getDataDir(), label), JSON.stringify({ label, startsMs: [now + 60 * MINUTE] }));
    if (state === 'unsupported platform') Object.defineProperty(process, 'platform', { value: 'linux' });
    await observe(now, 6);
    expect(incidents()[0].status).toBe('human_required');
    expect(incidents()[0].resolvedAt).toBeNull();
  });

  it('does not recreate a recovered incident from unchanged crash history after a supervisor restart', async () => {
    await startLoop();
    await observe(now, 5);
    expect(incidents()[0].status).toBe('resolved');
    vi.resetModules();
    const restarted = await import('./launch-agent-health');
    await restarted.surfaceLaunchAgentCrashLoops(now + 6 * MINUTE);
    expect(incidents()).toHaveLength(1);
    expect(incidents()[0].status).toBe('resolved');
  });

  it('keeps the card active when a new start is recorded during the recovery probe', async () => {
    await startLoop();
    await observe(now, 4);
    probe.mockImplementationOnce(() => {
      recordLaunchAgentStart({ dataDir: getDataDir(), label, parentPid: 1, nowMs: now + 5 * MINUTE });
      return running();
    });
    await surfaceLaunchAgentCrashLoops(now + 5 * MINUTE);
    expect(incidents()[0].status).toBe('human_required');
  });

  it('lets timers run during a slow probe and shares overlapping scheduled checks', async () => {
    await startLoop();
    await observe(now, 4);
    let completeProbe: (output: string) => void = () => { throw new Error('probe not started'); };
    probe.mockImplementationOnce(() => new Promise<string>((resolve) => { completeProbe = resolve; }));
    const pending = surfaceLaunchAgentCrashLoops(now + 5 * MINUTE);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(incidents()[0].status).toBe('human_required');
    expect(surfaceLaunchAgentCrashLoops(now + 6 * MINUTE)).toBe(pending);
    completeProbe(running());
    await pending;
    expect(incidents()[0].status).toBe('resolved');
  });

  it('preserves an operator dismissal made while the recovery probe is pending', async () => {
    const original = await startLoop();
    await observe(now, 4);
    let completeProbe: (output: string) => void = () => { throw new Error('probe not started'); };
    probe.mockImplementationOnce(() => new Promise<string>((resolve) => { completeProbe = resolve; }));
    const pending = surfaceLaunchAgentCrashLoops(now + 5 * MINUTE);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    dismissInboxItem(original.id);
    completeProbe(running());
    await pending;
    const row = getSqlite().prepare('SELECT status, payload FROM supervisor_inbox WHERE id = ?').get(original.id) as { status: string; payload: string };
    expect(row.status).toBe('dismissed');
    expect(JSON.parse(row.payload).autoResolution).toBeUndefined();
  });

  it.each(['probe failure', 'observation gap', 'pid change', 'run change', 'new start'])('restarts the healthy interval after a %s', async (change) => {
    await startLoop();
    await observe(now, 3);
    let resetAt = now + 4 * MINUTE;
    if (change === 'probe failure') {
      probe.mockImplementationOnce(() => { throw new Error('probe unavailable'); });
      await surfaceLaunchAgentCrashLoops(resetAt);
      resetAt += MINUTE;
    }
    if (change === 'observation gap') resetAt += 2 * MINUTE;
    if (change === 'pid change') probe.mockImplementation(() => running(456));
    if (change === 'run change') probe.mockImplementation(() => running(123, 5));
    if (change === 'new start') recordLaunchAgentStart({ dataDir: getDataDir(), label, parentPid: 1, nowMs: resetAt });
    await surfaceLaunchAgentCrashLoops(resetAt);
    await observe(resetAt, 4);
    expect(incidents()[0].status).toBe('human_required');
    await surfaceLaunchAgentCrashLoops(resetAt + 5 * MINUTE);
    expect(incidents()[0].status).toBe('resolved');
  });

  it('accepts a healthy counter reset but keeps a later crash as a new incident, including after a supervisor restart', async () => {
    const original = await startLoop();
    await observe(now, 4);
    expect(markLaunchAgentHealthy({ dataDir: getDataDir(), label, nowMs: now + 5 * MINUTE, startedAtMs: now })).toBe(true);
    await surfaceLaunchAgentCrashLoops(now + 5 * MINUTE);
    expect(incidents()[0].status).toBe('resolved');

    vi.resetModules();
    const restarted = await import('./launch-agent-health');
    await restarted.surfaceLaunchAgentCrashLoops(now + 6 * MINUTE);
    expect(incidents()).toHaveLength(1);
    for (let offset = 3; offset >= 0; offset -= 1) {
      recordLaunchAgentStart({ dataDir: getDataDir(), label, parentPid: 1, nowMs: now + 7 * MINUTE - offset * 1_000 });
    }
    await restarted.surfaceLaunchAgentCrashLoops(now + 7 * MINUTE);
    const records = incidents();
    expect(records).toHaveLength(2);
    expect(records.find((item) => item.id === original.id)?.status).toBe('resolved');
    expect(records.find((item) => item.id !== original.id)?.status).toBe('human_required');
  });
});
