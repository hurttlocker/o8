import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import { getDataDir } from '@/lib/data-dir-migration';
import {
  launchAgentCounterPath,
  recordLaunchAgentStart,
} from '@/lib/mcp/launch-agent-crash-counter';
import { listInboxItems } from '@/lib/supervisor/inbox';
import { surfaceLaunchAgentCrashLoop } from './launch-agent-health';

afterEach(() => {
  rmSync(launchAgentCounterPath(getDataDir()), { force: true });
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
});
