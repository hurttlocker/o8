import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import { getDataDir } from '@/lib/data-dir-migration';
import {
  launchAgentCounterPath,
  recordLaunchAgentStart,
} from '@/lib/mcp/launch-agent-crash-counter';
import { listInboxItems } from '@/lib/supervisor/inbox';
import { surfaceLaunchAgentCrashLoop, surfaceLaunchAgentCrashLoops } from './launch-agent-health';

const SECONDARY_LABEL = 'com.rainwater.o8-worker';

afterEach(() => {
  rmSync(launchAgentCounterPath(getDataDir()), { force: true });
  rmSync(launchAgentCounterPath(getDataDir(), SECONDARY_LABEL), { force: true });
  rmSync(launchAgentCounterPath(getDataDir(), '0'), { force: true });
});

describe('LaunchAgent Incident Queue bridge', () => {
  it('surfaces repeated launchd restarts through the real supervisor inbox', () => {
    const dataDir = getDataDir();
    const nowMs = Date.now();
    for (let offset = 3; offset >= 0; offset -= 1) {
      recordLaunchAgentStart({ dataDir, parentPid: 1, nowMs: nowMs - offset * 1_000 });
    }

    expect(surfaceLaunchAgentCrashLoop(nowMs)).toBe(3);
    const incident = listInboxItems({ includeAllProjects: true }).find(
      (item) => item.kind === 'launch_agent_crash_loop',
    );
    expect(incident?.status).toBe('human_required');
    expect(incident?.errorExcerpt).toBe('com.rainwater.mcp-o8 failed 3 times in the last hour');
    expect(surfaceLaunchAgentCrashLoop(nowMs)).toBe(0);
  });

  it('discovers and surfaces counters from other o8 LaunchAgent services', () => {
    const dataDir = getDataDir();
    const nowMs = Date.now();
    for (let offset = 3; offset >= 0; offset -= 1) {
      recordLaunchAgentStart({
        dataDir,
        label: SECONDARY_LABEL,
        parentPid: 1,
        nowMs: nowMs - offset * 1_000,
      });
    }

    expect(surfaceLaunchAgentCrashLoops(nowMs)).toEqual([{
      label: SECONDARY_LABEL,
      failureCount: 3,
    }]);
    const incident = listInboxItems({ includeAllProjects: true }).find(
      (item) => item.kind === 'launch_agent_crash_loop' && item.errorExcerpt?.includes(SECONDARY_LABEL),
    );
    expect(incident?.status).toBe('human_required');
    expect(incident?.errorExcerpt).toBe(`${SECONDARY_LABEL} failed 3 times in the last hour`);
  });
});
